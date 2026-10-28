import type { DownloadFailureKind, DownloadResult } from "./downloader";
import { extractImageReferences, rewriteImageReferences, type ImageReference } from "./links";

export interface ImageResourceMap {
  [remoteUrl: string]: string;
}

export interface PendingFailure {
  kind: DownloadFailureKind;
  attempts: number;
}

export interface PendingNote {
  failures: Record<string, PendingFailure>;
}

export type PendingNotes = Record<string, PendingNote>;

export const MAX_IMAGES_PER_NOTE = 24;
export const MAX_ATTEMPTS_PER_URL = 3;
export const IMAGE_CONCURRENCY = 3;

export interface LocalizerDependencies {
  download: (url: string) => Promise<DownloadResult>;
  upload: (noteId: string, file: File) => Promise<{ url: string }>;
  loadMap: (noteId: string) => Promise<ImageResourceMap>;
  saveMap: (noteId: string, map: ImageResourceMap) => Promise<void>;
  loadPending: () => Promise<PendingNotes>;
  savePending: (pending: PendingNotes) => Promise<void>;
  maxImagesPerNote?: number;
  maxAttempts?: number;
  concurrency?: number;
}

export interface LocalizedFailure {
  url: string;
  kind: DownloadFailureKind;
  error: string;
}

export interface LocalizeResult {
  markdown: string;
  uploaded: number;
  remoteKept: number;
  failures: LocalizedFailure[];
}

const isNonRetryable = (failure: PendingFailure | undefined): boolean =>
  failure !== undefined && (failure.kind === "permanent" || failure.kind === "too_large");

async function mapWithConcurrency<T>(values: T[], concurrency: number, run: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      await run(values[index]);
    }
  });
  await Promise.all(workers);
}

/**
 * Saves remote article images into the note itself through the host resource
 * API. Failures never block a note: the image keeps its remote link, permanent
 * failures stop being retried, and transient ones get a bounded number of
 * attempts across later sync runs.
 */
export class ImageLocalizer {
  private readonly maxImages: number;
  private readonly maxAttempts: number;
  private readonly concurrency: number;

  constructor(private readonly deps: LocalizerDependencies) {
    this.maxImages = deps.maxImagesPerNote ?? MAX_IMAGES_PER_NOTE;
    this.maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS_PER_URL;
    this.concurrency = deps.concurrency ?? IMAGE_CONCURRENCY;
  }

  async localize(
    markdown: string,
    noteId: string,
    references: readonly ImageReference[] = extractImageReferences(markdown),
  ): Promise<LocalizeResult> {
    if (!references.length) return { markdown, uploaded: 0, remoteKept: 0, failures: [] };

    const unique = new Map<string, { label: string; url: string }>();
    for (const reference of references) {
      if (!unique.has(reference.url)) unique.set(reference.url, { label: reference.label, url: reference.url });
    }

    const map = await this.deps.loadMap(noteId);
    const pending = await this.deps.loadPending();
    // Older releases stored an `attempts` counter here; it was written but never
    // read, so it is simply dropped when the entry is rebuilt.
    const pendingNote: PendingNote = { failures: { ...(pending[noteId]?.failures ?? {}) } };
    const replacements = new Map<string, string>();
    const failures: LocalizedFailure[] = [];
    let mapChanged = false;
    let pendingChanged = false;

    const recordFailure = (url: string, kind: DownloadFailureKind, error: string): void => {
      failures.push({ url, kind, error });
      const previous = pendingNote.failures[url];
      pendingNote.failures[url] = { kind, attempts: (previous?.attempts ?? 0) + 1 };
      pendingChanged = true;
    };

    const toDownload: Array<{ label: string; url: string }> = [];
    for (const reference of unique.values()) {
      const known = map[reference.url];
      if (known) {
        replacements.set(reference.url, known);
        continue;
      }
      const previous = pendingNote.failures[reference.url];
      if (isNonRetryable(previous) || (previous !== undefined && previous.attempts >= this.maxAttempts)) continue;
      if (toDownload.length >= this.maxImages) continue;
      toDownload.push(reference);
    }

    await mapWithConcurrency(toDownload, this.concurrency, async (reference) => {
      const result = await this.deps.download(reference.url);
      if (!result.ok) {
        recordFailure(reference.url, result.kind, result.error);
        return;
      }
      try {
        const file = new File([result.data as unknown as BlobPart], result.filename, { type: result.mimeType });
        const resource = await this.deps.upload(noteId, file);
        if (!resource?.url) throw new Error("上传后没有返回地址");
        map[reference.url] = resource.url;
        replacements.set(reference.url, resource.url);
        mapChanged = true;
        if (pendingNote.failures[reference.url]) {
          delete pendingNote.failures[reference.url];
          pendingChanged = true;
        }
      } catch (error) {
        recordFailure(reference.url, "transient", error instanceof Error ? error.message : "图片保存失败");
      }
    });

    if (mapChanged) await this.deps.saveMap(noteId, map);
    if (pendingChanged) {
      if (Object.keys(pendingNote.failures).length === 0) {
        delete pending[noteId];
      } else {
        pending[noteId] = pendingNote;
      }
      await this.deps.savePending(pending);
    }

    return {
      markdown: rewriteImageReferences(markdown, references, replacements),
      uploaded: replacements.size,
      // Every distinct URL that did not end up with a local replacement kept its remote link.
      remoteKept: unique.size - replacements.size,
      failures,
    };
  }
}
