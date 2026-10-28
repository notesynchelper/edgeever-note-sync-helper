/**
 * Local de-duplication index.
 *
 * `storage` is per device, so the index can disappear (new device, cleared
 * data, reinstalled plugin). The authoritative marker lives inside the note's
 * own properties block (`notehelper-id`); the index is only a fast path and
 * carries the hashes needed to tell "our last write" from "the user edited it".
 */

import { isRecord } from "../util/parse";

export interface NoteIndexEntry {
  noteId: string;
  /** Hash of the markdown this plugin last wrote (after image localisation). */
  writtenHash: string;
  /** Hash of the rendered markdown before image localisation. */
  renderedHash: string;
  remoteUpdatedAt: string;
}

export type NoteIndex = Record<string, NoteIndexEntry>;

export type SyncAction = "create" | "update" | "skip" | "conflict";

export function cleanIndex(value: unknown): NoteIndex {
  const index: NoteIndex = Object.create(null);
  if (!isRecord(value)) return index;
  for (const [sourceId, raw] of Object.entries(value)) {
    if (!sourceId || !isRecord(raw)) continue;
    const noteId = typeof raw.noteId === "string" ? raw.noteId : "";
    if (!noteId) continue;
    index[sourceId] = {
      noteId,
      writtenHash: typeof raw.writtenHash === "string" ? raw.writtenHash : "",
      renderedHash: typeof raw.renderedHash === "string" ? raw.renderedHash : "",
      remoteUpdatedAt: typeof raw.remoteUpdatedAt === "string" ? raw.remoteUpdatedAt : "",
    };
  }
  return index;
}

/** The index already holds this exact render; the note does not even need reading. */
function isUnchanged(entry: NoteIndexEntry, renderedHash: string, remoteUpdatedAt: string): boolean {
  return entry.remoteUpdatedAt === remoteUpdatedAt && entry.renderedHash === renderedHash;
}

/**
 * True when the note no longer holds what this plugin last wrote.
 *
 * An entry rebuilt from the note's own marker has no recorded hash. Treating
 * that as "the user may have edited it" means a lost index can never overwrite
 * the user's copy — the safe direction, at the cost of not applying template
 * changes to those notes.
 */
export function isUserEdited(entry: NoteIndexEntry, currentHash: string): boolean {
  return entry.writtenHash === "" || entry.writtenHash !== currentHash;
}

export interface SyncPlanInput {
  entry?: NoteIndexEntry;
  renderedHash: string;
  remoteUpdatedAt: string;
  /**
   * Reads the note's current hash. Only called when a write is being
   * considered, so an unchanged article never pays for reading it.
   */
  currentHash?: () => Promise<string>;
}

/**
 * - create: nothing known about this article yet.
 * - skip: neither the article nor the templates changed since the last write.
 * - conflict: the note no longer matches what this plugin wrote; the user owns it now.
 * - update: rewrite title, folder and body.
 */
export async function planSync(input: SyncPlanInput): Promise<SyncAction> {
  const { entry, renderedHash, remoteUpdatedAt, currentHash } = input;
  if (!entry) return "create";
  if (isUnchanged(entry, renderedHash, remoteUpdatedAt)) return "skip";
  if (!currentHash) return "update";
  return isUserEdited(entry, await currentHash()) ? "conflict" : "update";
}

/** True when a failed `notes.get` means the note is gone rather than the network hiccuped. */
export function isMissingNoteError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  if (candidate.status === 404) return true;
  if (typeof candidate.code === "string" && /not_?found|missing|deleted/i.test(candidate.code)) return true;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return /not found|does not exist|不存在|已删除/i.test(message);
}
