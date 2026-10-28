import { ArticleClient } from "../api/client";
import { parseDevEndpoint } from "../api/endpoints";
import { ApiRequestError, MissingKeyError } from "../api/types";
import type { PluginContext } from "../edgeever";
import { readSettings } from "../settings";
import { extractSourceId } from "../template/frontMatter";
import { TemplateError } from "../template/helpers";
import {
  ImageLocalizer,
  type ImageResourceMap,
  type PendingNote,
  type PendingNotes,
} from "../resources/localizer";
import { downloadImage } from "../resources/downloader";
import { USER_FACING_TEXT } from "../ui/text";
import { hashText } from "../util/hash";
import { isRecord } from "../util/parse";
import { cleanIndex, isUserEdited, type NoteIndex } from "./dedupe";
import { isTemporaryId, TemporaryIdTimeoutError } from "./ids";
import { NotebookResolver } from "./notebooks";
import { localizeNoteImages, processItem } from "./processor";
import { defaultRemoteIdWaiter, type RemoteIdWaiter } from "./remap";
import { advanceCursor } from "./cursor";

export const STORAGE_KEYS = {
  cursor: "sync.cursor",
  index: "sync.index",
  endpoint: "sync.endpoint",
  /** Development only: a loopback article mock; never surfaced in the UI. */
  devEndpoint: "sync.devEndpoint",
  lastRun: "lastRun",
  imageMap: "images.map",
  imagePending: "images.pending",
} as const;

export const MAX_SCAN_PAGES = 15;
export const SCAN_PAGE_SIZE = 200;
export const MAX_PENDING_NOTES_PER_RUN = 10;

export interface RunCounts {
  created: number;
  updated: number;
  skipped: number;
  imagesLocal: number;
  imagesRemote: number;
}

export interface LastRun extends RunCounts {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error?: string;
}

export interface SyncServiceOptions {
  context: PluginContext;
  now?: () => Date;
  onNotice?: (message: string) => void;
  /** Overridable so tests can drive the host clock; production uses the real one. */
  waiter?: RemoteIdWaiter;
}

interface ImageStores {
  maps: Record<string, ImageResourceMap>;
  pending: PendingNotes;
}

const EMPTY_COUNTS: RunCounts = { created: 0, updated: 0, skipped: 0, imagesLocal: 0, imagesRemote: 0 };

export class SyncService {
  private running: Promise<LastRun> | null = null;

  constructor(private readonly options: SyncServiceOptions) {}

  private get context(): PluginContext {
    return this.options.context;
  }

  private get now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private get waiter(): RemoteIdWaiter {
    return this.options.waiter ?? defaultRemoteIdWaiter;
  }

  /** One wait budget per run: a stuck queue must not be paid once per article. */
  private runWaiter(): RemoteIdWaiter {
    const base = this.waiter;
    let stalled = false;
    return async (wait) => {
      if (stalled) return null;
      const remoteId = await base(wait);
      if (!remoteId) stalled = true;
      return remoteId;
    };
  }

  private notice(message: string): void {
    if (this.options.onNotice) this.options.onNotice(message);
    else this.context.ui.showNotice(message);
  }

  /** One sync at a time; a second trigger joins the run already in progress. */
  run(): Promise<LastRun> {
    if (this.running) return this.running;
    const running = this.runOnce().finally(() => {
      if (this.running === running) this.running = null;
    });
    this.running = running;
    return running;
  }

  /** Never rejects: the contract needs a notice and a `lastRun` record either way. */
  private async runOnce(): Promise<LastRun> {
    const startedAt = this.now.toISOString();
    try {
      return await this.execute(startedAt);
    } catch (error) {
      const reason = describeFailure(error);
      this.notice(USER_FACING_TEXT.notices.failure(reason));
      return this.record(startedAt, false, EMPTY_COUNTS, reason);
    }
  }

  /** The only place a `lastRun` record is built. */
  private async record(startedAt: string, ok: boolean, counts: RunCounts, error?: string): Promise<LastRun> {
    const lastRun: LastRun = {
      startedAt,
      finishedAt: this.now.toISOString(),
      ok,
      ...counts,
      ...(error ? { error } : {}),
    };
    // A full storage quota must not hide the run result from the user.
    await this.safeSet(STORAGE_KEYS.lastRun, lastRun);
    return lastRun;
  }

  private async execute(startedAt: string): Promise<LastRun> {
    const settings = await readSettings(this.context);
    if (!settings.apiKey) throw new MissingKeyError();
    this.notice(USER_FACING_TEXT.notices.running);

    const [cursorRaw, indexRaw, endpointRaw, devEndpointRaw] = await Promise.all([
      this.safeGet<string>(STORAGE_KEYS.cursor),
      this.safeGet<unknown>(STORAGE_KEYS.index),
      this.safeGet<string>(STORAGE_KEYS.endpoint),
      this.safeGet<unknown>(STORAGE_KEYS.devEndpoint),
    ]);
    const cursor = cursorRaw ?? "";
    const index = cleanIndex(indexRaw);
    const preferredEndpoint = endpointRaw ?? undefined;
    // Loopback mock for development; ignored for any other value and never
    // written back, so it cannot become a cached entry point.
    const devEndpoint = parseDevEndpoint(devEndpointRaw);

    const client = new ArticleClient({
      apiKey: settings.apiKey,
      fetchImpl: (input, init) => this.context.network.fetch(input, init),
      preferredEndpoint,
      devEndpoint,
    });
    // A missing key, an unreachable service or a broken template all leave
    // through here; `runOnce` is the single failure exit.
    const { items, endpoint } = await client.fetchAll(cursor);

    // When the host queue stops draining, every remaining article would spend
    // the full wait before failing. Once one wait times out the queue is stuck
    // for this run too, so the rest fail immediately and the run stays short.
    const waiter = this.runWaiter();
    const notebooks = new NotebookResolver(this.context.notebooks, waiter);
    let stores: ImageStores | null = null;
    let localizer: ImageLocalizer | undefined;
    if (settings.imageMode === "local") {
      const loaded = await this.loadImageStores();
      stores = loaded;
      localizer = new ImageLocalizer({
        download: (url) => downloadImage(url, {
          fetchImpl: (input, init) => this.context.network.fetch(input, init),
        }),
        upload: async (noteId, file) => {
          const resource = await this.context.resources.upload(noteId, file);
          return { url: resource.url };
        },
        loadMap: async (noteId) => loaded.maps[noteId] ?? {},
        saveMap: async (noteId, map) => {
          loaded.maps[noteId] = map;
          await this.safeSet(STORAGE_KEYS.imageMap, loaded.maps);
        },
        loadPending: async () => loaded.pending,
        savePending: async (pending) => {
          loaded.pending = pending;
          await this.safeSet(STORAGE_KEYS.imagePending, pending);
        },
      });
    }

    let anchorMap: Map<string, string> | null = null;
    const findNoteBySourceId = async (sourceId: string): Promise<string | null> => {
      if (!anchorMap) anchorMap = await this.scanAnchors();
      return anchorMap.get(sourceId) ?? null;
    };

    const persistIndex = async (): Promise<void> => {
      await this.safeSet(STORAGE_KEYS.index, index);
    };

    const counts: RunCounts = { ...EMPTY_COUNTS };
    let failed = 0;
    let firstFailure: { reason: string } | null = null;
    // Articles this run actually wrote; only those have to prove they hold a
    // cloud id before the run may be called complete.
    const outcomes = new Map<string, { action: "created" | "updated" | "skipped"; imagesLocal: number; imagesRemote: number }>();
    for (const item of items) {
      try {
        const outcome = await processItem({
          item,
          settings,
          index,
          notes: this.context.notes,
          notebooks,
          localizer,
          hash: hashText,
          findNoteBySourceId,
          persistIndex,
          waitForRemoteId: waiter,
        });
        outcomes.set(item.id, outcome);
      } catch (error) {
        failed += 1;
        firstFailure ??= { reason: describeFailure(error) };
      }
    }

    // Notes the host still keeps only in its local mirror cannot accept images
    // and would not exist on another device. Report them as unfinished (and
    // keep the cursor back) instead of a clean run that silently lost them.
    for (const [sourceId, outcome] of outcomes) {
      if (outcome.action === "skipped") continue;
      const entry = index[sourceId];
      if (entry && !isTemporaryId(entry.noteId)) continue;
      outcomes.delete(sourceId);
      failed += 1;
      firstFailure ??= { reason: USER_FACING_TEXT.reasons.stillSaving };
    }
    for (const outcome of outcomes.values()) {
      if (outcome.action === "created") counts.created += 1;
      else if (outcome.action === "updated") counts.updated += 1;
      else counts.skipped += 1;
      counts.imagesLocal += outcome.imagesLocal;
      counts.imagesRemote += outcome.imagesRemote;
    }

    // Both retry passes need "note → article", so build the reverse index once.
    const sourceIdByNoteId = new Map<string, string>();
    for (const [sourceId, entry] of Object.entries(index)) sourceIdByNoteId.set(entry.noteId, sourceId);
    // Notes already touched by the main loop must not be retried again in the
    // same run; that would burn two attempts of the per-URL budget at once.
    const processedNoteIds = new Set<string>();
    for (const item of items) {
      const entry = index[item.id];
      if (entry) processedNoteIds.add(entry.noteId);
    }

    // Images that could not be fetched keep their remote link; retry a bounded
    // number of notes on later runs instead of blocking this one.
    if (localizer && stores) {
      try {
        const resumed = await this.resumePendingImages(index, localizer, stores, sourceIdByNoteId, processedNoteIds);
        counts.imagesLocal += resumed.imagesLocal;
        counts.imagesRemote += resumed.imagesRemote;
      } catch {
        // never fail the whole run because of a retry pass
      }
      await this.pruneImageMaps(stores, sourceIdByNoteId).catch(() => undefined);
    }

    if (failed === 0) {
      const nextCursor = advanceCursor(items, cursor);
      if (nextCursor) await this.safeSet(STORAGE_KEYS.cursor, nextCursor);
      // A development mock must never become the cached entry point.
      const usedDevEndpoint = devEndpoint !== null && endpoint.startsWith(devEndpoint);
      if (!usedDevEndpoint) await this.safeSet(STORAGE_KEYS.endpoint, endpoint);
    }

    if (failed > 0 && firstFailure) {
      const reason = firstFailure.reason;
      if (counts.created + counts.updated + counts.skipped === 0) {
        // Nothing at all went through: report a failure rather than a hollow success.
        this.notice(USER_FACING_TEXT.notices.failure(reason));
        return this.record(startedAt, false, counts, reason);
      }
      this.notice(USER_FACING_TEXT.notices.partial(counts, failed));
      return this.record(startedAt, false, counts, `${failed} 篇未完成：${reason}`);
    }

    this.notice(USER_FACING_TEXT.notices.success(counts));
    return this.record(startedAt, true, counts);
  }

  private async scanAnchors(): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    let offset = 0;
    for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
      const result = await this.context.notes.queryContent({ limit: SCAN_PAGE_SIZE, offset, sort: "updated-desc" });
      for (const note of result.notes) {
        const sourceId = extractSourceId(note.contentMarkdown);
        if (sourceId && !found.has(sourceId)) found.set(sourceId, note.id);
      }
      if (result.nextOffset === null || result.notes.length === 0) break;
      offset = result.nextOffset;
    }
    return found;
  }

  private async resumePendingImages(
    index: NoteIndex,
    localizer: ImageLocalizer,
    stores: ImageStores,
    noteIds: ReadonlyMap<string, string>,
    processedNoteIds: ReadonlySet<string>,
  ): Promise<{ imagesLocal: number; imagesRemote: number }> {
    const pending = stores.pending;
    const hasFailures = (note: PendingNote): boolean =>
      isRecord(note) && isRecord(note.failures) && Object.keys(note.failures).length > 0;
    const candidates = Object.entries(pending)
      .filter(([noteId, note]) => !processedNoteIds.has(noteId) && hasFailures(note))
      .slice(0, MAX_PENDING_NOTES_PER_RUN);
    let imagesLocal = 0;
    let imagesRemote = 0;
    let pendingChanged = false;
    let indexChanged = false;

    for (const [noteId] of candidates) {
      const sourceId = noteIds.get(noteId);
      const entry = sourceId === undefined ? undefined : index[sourceId];
      if (!entry) {
        delete pending[noteId];
        pendingChanged = true;
        continue;
      }
      if (isTemporaryId(noteId)) {
        // The note still lives only on this device; its retry waits until the
        // host has published the cloud id (and the index was healed).
        delete pending[noteId];
        pendingChanged = true;
        continue;
      }
      const note = await this.context.notes.get(noteId).catch(() => null);
      if (!note) {
        delete pending[noteId];
        pendingChanged = true;
        continue;
      }
      if (isUserEdited(entry, await hashText(note.contentMarkdown))) {
        // The user edited the note (or the index was rebuilt without a hash);
        // stop trying to rewrite its images.
        delete pending[noteId];
        pendingChanged = true;
        continue;
      }
      const step = await localizeNoteImages({
        noteId,
        markdown: note.contentMarkdown,
        localizer,
        notes: this.context.notes,
        hash: hashText,
      });
      imagesLocal += step.imagesLocal;
      imagesRemote += step.imagesRemote;
      if (step.writtenHash) {
        entry.writtenHash = step.writtenHash;
        indexChanged = true;
      }
    }

    if (pendingChanged) await this.safeSet(STORAGE_KEYS.imagePending, pending);
    if (indexChanged) await this.safeSet(STORAGE_KEYS.index, index);
    return { imagesLocal, imagesRemote };
  }

  private async loadImageStores(): Promise<ImageStores> {
    const [maps, pending] = await Promise.all([
      this.safeGet<Record<string, ImageResourceMap>>(STORAGE_KEYS.imageMap),
      this.safeGet<PendingNotes>(STORAGE_KEYS.imagePending),
    ]);
    return {
      maps: isRecord(maps) ? { ...maps } : {},
      pending: isRecord(pending) ? { ...pending } : {},
    };
  }

  private async pruneImageMaps(stores: ImageStores, noteIds: ReadonlyMap<string, string>): Promise<void> {
    const live = new Set(noteIds.keys());
    let changed = false;
    for (const noteId of Object.keys(stores.maps)) {
      if (!live.has(noteId)) {
        delete stores.maps[noteId];
        changed = true;
      }
    }
    if (changed) await this.safeSet(STORAGE_KEYS.imageMap, stores.maps);
  }

  private async safeGet<T>(key: string): Promise<T | null> {
    try {
      return await this.context.storage.get<T>(key);
    } catch {
      return null;
    }
  }

  private async safeSet(key: string, value: unknown): Promise<void> {
    try {
      await this.context.storage.set(key, value);
    } catch {
      // Best effort: the next run recomputes whatever it needs.
    }
  }
}

/** Maps an internal error to wording a user can act on. */
export function describeFailure(error: unknown): string {
  if (error instanceof MissingKeyError) return USER_FACING_TEXT.reasons.missingKey;
  if (error instanceof TemplateError) return USER_FACING_TEXT.reasons.template;
  if (error instanceof TemporaryIdTimeoutError) return USER_FACING_TEXT.reasons.stillSaving;
  if (error instanceof ApiRequestError) {
    switch (error.kind) {
      case "business":
        return USER_FACING_TEXT.reasons.invalidKey;
      case "rate_limit":
        return USER_FACING_TEXT.reasons.rateLimited;
      case "network":
        return USER_FACING_TEXT.reasons.network;
      default:
        return USER_FACING_TEXT.reasons.service;
    }
  }
  return USER_FACING_TEXT.reasons.unknown;
}
