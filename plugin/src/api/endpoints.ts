import type { FailureKind } from "./types";
import { parseUrl } from "../util/parse";

/**
 * Article service entry points. All four answer with permissive CORS headers,
 * so the browser transport works without any relay. They are tried in this
 * order; a cached successful one is moved to the front on later runs.
 */
export const OFFICIAL_BASES = [
  "https://relay-1.bijitongbu.site/helper",
  "https://relay-2.bijitongbu.site",
  "https://graph.bijitongbu.site",
  "https://obsidian.notebooksyncer.com",
] as const;

export const GRAPHQL_PATH = "/api/graphql";

/**
 * Development entry point (`sync.devEndpoint` in plugin storage).
 *
 * Deliberately narrow: loopback over plain HTTP, explicit port, no path. A real
 * user never has this key set, so a tampered value cannot redirect their key
 * anywhere meaningful — and it is never written back to `sync.endpoint`.
 */
export function parseDevEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const url = parseUrl(trimmed);
  if (!url) return null;
  if (url.protocol !== "http:") return null;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
  if (!url.port) return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  return `${url.protocol}//${url.host}`;
}

export function classifyStatus(status: number): FailureKind {
  if (!Number.isFinite(status)) return "network";
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403 || status === 422) return "business";
  if (status === 0) return "network";
  if (status === 404 || status === 405 || status === 502 || status === 503 || status === 504) return "gateway";
  // A plain 5xx comes from the application itself; switching entry points would
  // just repeat the same failure on every host.
  if (status >= 500) return "app_5xx";
  return "gateway";
}

/** Only transport-level failures move on to the next entry point. */
export function canFallback(kind: FailureKind): boolean {
  return kind === "network" || kind === "gateway";
}

/**
 * Returns fully qualified request URLs in try order. `preferred` is a base that
 * succeeded earlier; it is only honoured when it still matches one of the known
 * entry points (the list only ever holds those), so a stale or tampered cache
 * cannot redirect the key. `devBase` — an explicit loopback mock — goes first
 * and is the only base that bypasses that check.
 */
export function endpointCandidates(preferred?: string, devBase?: string | null): string[] {
  const normalizedPreferred = preferred ? stripPath(preferred) : "";
  const bases = [...OFFICIAL_BASES];
  const index = normalizedPreferred ? bases.findIndex((base) => base === normalizedPreferred) : -1;
  if (index > 0) {
    const [cached] = bases.splice(index, 1);
    bases.unshift(cached);
  }
  const dev = parseDevEndpoint(devBase);
  const ordered = dev ? [dev, ...bases] : bases;
  return ordered.map((base) => `${base}${GRAPHQL_PATH}`);
}

function stripPath(value: string): string {
  const url = parseUrl(value);
  if (!url) return "";
  return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "").replace(/\/api\/graphql$/, "");
}
