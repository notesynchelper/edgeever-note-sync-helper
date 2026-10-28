import type { ValidatedItem } from "../api/types";
import type { PluginContext, PluginNote, PluginNoteUpdateInput } from "../edgeever";
import type { PluginSettings } from "../settings";
import { buildFrontMatter, composeMarkdown } from "../template/frontMatter";
import { renderContent, renderPath, safeNoteTitle } from "../template/render";
import { extractImageReferences, type ImageReference } from "../resources/links";
import type { ImageLocalizer } from "../resources/localizer";
import { isMissingNoteError, planSync, type NoteIndex, type NoteIndexEntry } from "./dedupe";
import { isTemporaryId, TemporaryIdTimeoutError } from "./ids";
import type { NotebookResolver } from "./notebooks";
import { defaultRemoteIdWaiter, noteRemapEvents, type RemoteIdWaiter } from "./remap";

export type NoteStore = Pick<PluginContext["notes"], "get" | "create" | "update" | "move">;

export interface RenderedNote {
  title: string;
  notebookPath: string;
  markdown: string;
  tags: string[];
  renderedHash: string;
  imageReferences: ImageReference[];
  /** Distinct image URLs; matches how the localizer counts them. */
  imageCount: number;
}

export type HashText = (value: string) => Promise<string>;

/** Renders every user template for one article. Throws `TemplateError` on bad syntax. */
export async function renderNote(item: ValidatedItem, settings: PluginSettings, hash: HashText): Promise<RenderedNote> {
  const title = safeNoteTitle(renderPath(item, settings.titleTemplate, settings.folderDateFormat), item.id);
  const notebookPath = renderPath(item, settings.folderTemplate, settings.folderDateFormat);
  const frontMatter = buildFrontMatter(item, settings.frontMatterTemplate, settings.folderDateFormat);
  const body = renderContent(item, settings.articleTemplate, settings.folderDateFormat);
  const markdown = composeMarkdown(frontMatter.yaml, body);
  const imageReferences = extractImageReferences(markdown);
  return {
    title,
    notebookPath,
    markdown,
    tags: frontMatter.tags,
    // Title and folder are template output too: changing either must count as a
    // change even when the article body renders identically.
    renderedHash: await hash(`${title}\n${notebookPath}\n${markdown}`),
    imageReferences,
    imageCount: new Set(imageReferences.map((reference) => reference.url)).size,
  };
}

export interface ProcessItemOptions {
  item: ValidatedItem;
  settings: PluginSettings;
  index: NoteIndex;
  notes: NoteStore;
  notebooks: NotebookResolver;
  localizer?: ImageLocalizer;
  hash: HashText;
  /** Fallback lookup when the local index has no entry for this article. */
  findNoteBySourceId: (sourceId: string) => Promise<string | null>;
  persistIndex: () => Promise<void>;
  /** Overridable so tests can drive the host clock; production uses the real one. */
  waitForRemoteId?: RemoteIdWaiter;
}

export interface ProcessOutcome {
  action: "created" | "updated" | "skipped";
  imagesLocal: number;
  imagesRemote: number;
}

const union = (left: readonly string[], right: readonly string[]): string[] =>
  [...new Set([...left, ...right])];

const sameTags = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((tag) => right.includes(tag));

export interface LocalizeNoteInput {
  noteId: string;
  markdown: string;
  localizer: ImageLocalizer;
  notes: Pick<NoteStore, "update">;
  hash: HashText;
  /** References already extracted from `markdown`, when the caller has them. */
  references?: readonly ImageReference[];
}

export interface LocalizeNoteResult {
  markdown: string;
  /** Set only when the body was rewritten; otherwise the previous hash is still valid. */
  writtenHash?: string;
  imagesLocal: number;
  imagesRemote: number;
}

/**
 * Resolves a stored temporary id to the note's cloud id, using the host's own
 * id mapping first and the article anchor as the fallback. Returns null when
 * neither path can prove a cloud id yet.
 */
async function healTemporaryNoteId(
  noteId: string,
  sourceId: string,
  notes: Pick<NoteStore, "get">,
  findNoteBySourceId: (sourceId: string) => Promise<string | null>,
): Promise<string | null> {
  try {
    const note = await notes.get(noteId);
    if (!isTemporaryId(note.id)) return note.id;
  } catch {
    // The host may refuse a stale temporary id outright; the anchor still knows.
  }
  const bySource = await findNoteBySourceId(sourceId).catch(() => null);
  return bySource && !isTemporaryId(bySource) ? bySource : null;
}

/** Waits until a freshly created note carries a cloud id; throws when it never does. */
async function requireCloudNoteId(
  noteId: string,
  notes: Pick<NoteStore, "get">,
  waitForRemoteId: RemoteIdWaiter,
): Promise<string> {
  if (!isTemporaryId(noteId)) return noteId;
  const remoteId = await waitForRemoteId({
    temporaryId: noteId,
    // Reading the temporary id answers with the cloud note once the host has
    // swapped them; until then it keeps returning the temporary id.
    lookup: async () => (await notes.get(noteId)).id,
    events: noteRemapEvents(noteId),
  });
  if (!remoteId) throw new TemporaryIdTimeoutError();
  return remoteId;
}

/**
 * Downloads and stores a note's remote images, then persists the rewritten body.
 * A failed image keeps its remote link and never throws; a failed note write does.
 */
export async function localizeNoteImages(input: LocalizeNoteInput): Promise<LocalizeNoteResult> {
  const { noteId, markdown, localizer, notes, hash, references } = input;
  const localized = await localizer.localize(markdown, noteId, references).catch(() => null);
  if (!localized) return { markdown, imagesLocal: 0, imagesRemote: 0 };
  if (localized.markdown === markdown) {
    return { markdown, imagesLocal: localized.uploaded, imagesRemote: localized.remoteKept };
  }
  const updated = await notes.update(noteId, { contentMarkdown: localized.markdown });
  return {
    markdown: updated.contentMarkdown,
    writtenHash: await hash(updated.contentMarkdown),
    imagesLocal: localized.uploaded,
    imagesRemote: localized.remoteKept,
  };
}

/**
 * Brings one article into the workspace.
 *
 * Order matters for images: a note must exist before its images can be stored,
 * so a new note is created with remote links first, then rewritten once the
 * uploads come back. The index is persisted right after the first write, so an
 * interruption leaves the index consistent with what the note actually holds.
 */
export async function processItem(options: ProcessItemOptions): Promise<ProcessOutcome> {
  const { item, settings, index, notes, notebooks, hash, persistIndex } = options;
  const localizer = settings.imageMode === "local" ? options.localizer : undefined;
  const waitForRemoteId = options.waitForRemoteId ?? defaultRemoteIdWaiter;
  const rendered = await renderNote(item, settings, hash);
  const remoteUpdatedAt = item.updatedAt;

  let entry: NoteIndexEntry | undefined = index[item.id];
  if (entry && isTemporaryId(entry.noteId)) {
    // A previous run may have left a device-only id (it created the note just
    // as the host queue stalled). Resolve it before anything else so this run
    // writes to the cloud note instead of the temporary one.
    const healed = await healTemporaryNoteId(entry.noteId, item.id, notes, options.findNoteBySourceId);
    if (healed) {
      entry.noteId = healed;
      await persistIndex();
    }
  }
  if (!entry) {
    const found = await options.findNoteBySourceId(item.id);
    if (found) {
      entry = { noteId: found, writtenHash: "", renderedHash: "", remoteUpdatedAt: "" };
      index[item.id] = entry;
    }
  }

  let note: PluginNote | null = null;
  if (entry) {
    try {
      note = await notes.get(entry.noteId);
    } catch (error) {
      if (!isMissingNoteError(error)) throw error;
      delete index[item.id];
      await persistIndex();
      entry = undefined;
    }
  }

  const loadedNote = note;
  const action = await planSync({
    entry,
    renderedHash: rendered.renderedHash,
    remoteUpdatedAt,
    // Deferred: an unchanged article never pays for hashing the note body.
    currentHash: loadedNote ? () => hash(loadedNote.contentMarkdown) : undefined,
  });

  if (action === "conflict" && entry && note) {
    // The note no longer matches our last write (or the index was rebuilt and
    // cannot prove otherwise): the user owns it now. Only the article timestamp
    // is recorded so the next run does not re-read it.
    if (entry.remoteUpdatedAt !== remoteUpdatedAt) {
      entry.remoteUpdatedAt = remoteUpdatedAt;
      await persistIndex();
    }
    return { action: "skipped", imagesLocal: 0, imagesRemote: 0 };
  }

  if (action === "skip" && note) {
    return { action: "skipped", imagesLocal: 0, imagesRemote: localizer ? 0 : rendered.imageCount };
  }

  const notebookId = await notebooks.ensure(rendered.notebookPath);

  if (!note) {
    const created = await notes.create({
      notebookId,
      title: rendered.title,
      contentMarkdown: rendered.markdown,
      tags: rendered.tags,
    });
    const draftHash = await hash(rendered.markdown);
    index[item.id] = {
      noteId: created.id,
      writtenHash: draftHash,
      // Left empty until the whole pipeline finishes: a failure below must make
      // the next run pick this article up again.
      renderedHash: "",
      remoteUpdatedAt: "",
    };
    // Persist the temporary id before waiting: if the run dies mid-wait the
    // next run can still heal this entry instead of creating a second note.
    await persistIndex();
    const noteId = await requireCloudNoteId(created.id, notes, waitForRemoteId);
    const record = index[item.id];
    if (record.noteId !== noteId) {
      record.noteId = noteId;
      await persistIndex();
    }

    const step = localizer
      ? await localizeNoteImages({
        noteId,
        markdown: rendered.markdown,
        localizer,
        notes,
        hash,
        references: rendered.imageReferences,
      })
      : null;
    const stored = index[item.id];
    stored.writtenHash = step?.writtenHash ?? draftHash;
    stored.renderedHash = rendered.renderedHash;
    stored.remoteUpdatedAt = remoteUpdatedAt;
    await persistIndex();
    return {
      action: "created",
      imagesLocal: step?.imagesLocal ?? 0,
      imagesRemote: step?.imagesRemote ?? rendered.imageCount,
    };
  }

  // update path
  let moved = false;
  if (note.notebookId !== notebookId) {
    await notes.move([note.id], notebookId);
    moved = true;
  }

  const step = localizer
    ? await localizeNoteImages({
      noteId: note.id,
      markdown: rendered.markdown,
      localizer,
      notes,
      hash,
      references: rendered.imageReferences,
    })
    : null;
  const finalMarkdown = step?.markdown ?? rendered.markdown;

  const tags = union(note.tags ?? [], rendered.tags);
  const patch: PluginNoteUpdateInput = {};
  if (rendered.title !== (note.title ?? "")) patch.title = rendered.title;
  // The body is only patched when the image step did not already persist it.
  if (!step?.writtenHash && finalMarkdown !== note.contentMarkdown) patch.contentMarkdown = finalMarkdown;
  if (!sameTags(tags, note.tags ?? [])) patch.tags = tags;

  const wrote = step?.writtenHash !== undefined || Object.keys(patch).length > 0;
  const writtenMarkdown = Object.keys(patch).length > 0
    ? (await notes.update(note.id, patch)).contentMarkdown
    : finalMarkdown;

  index[item.id] = {
    noteId: note.id,
    writtenHash: step?.writtenHash ?? await hash(writtenMarkdown),
    renderedHash: rendered.renderedHash,
    remoteUpdatedAt,
  };
  await persistIndex();

  return {
    action: wrote || moved ? "updated" : "skipped",
    imagesLocal: step?.imagesLocal ?? 0,
    imagesRemote: step?.imagesRemote ?? rendered.imageCount,
  };
}
