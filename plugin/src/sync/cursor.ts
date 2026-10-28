import { parseDate } from "../util/parse";

/**
 * Cursor semantics: the highest `updatedAt` seen in a finished round.
 *
 * Deliberately without adding a second. Remote timestamps carry milliseconds
 * and the search filter is inclusive, so the item sitting exactly on the
 * boundary is fetched once more; de-duplication then treats it as unchanged.
 * Adding a second would instead open a window that is skipped forever.
 */
export function advanceCursor(items: ReadonlyArray<{ updatedAt?: string }>, previous = ""): string {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const value = parseDate(item.updatedAt)?.getTime();
    if (value !== undefined) maximum = Math.max(maximum, value);
  }
  return Number.isFinite(maximum) ? new Date(maximum).toISOString() : previous;
}
