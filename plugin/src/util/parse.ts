/**
 * Small parsing helpers shared across the sync pipeline.
 */

/** `new URL` without the try/catch boilerplate; null for anything unparsable. */
export function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** A usable date from a remote timestamp, or null. */
export function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Plain objects only: `null` and arrays are not records. Used to validate stored data. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
