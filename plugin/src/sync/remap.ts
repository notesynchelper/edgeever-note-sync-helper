/**
 * Waits for the host to swap a temporary id for a cloud one.
 *
 * The host announces the swap on its own window (`edgeever:notebook-id-remapped`
 * carries `{temporaryId, remoteId}`; `edgeever:memo-id-remapped` carries a
 * `Map<local, remote>`), and the local mirror also stops reporting the
 * temporary id. We use the event as an accelerator and a read-back poll as the
 * authority, so a missed event only costs a poll instead of a stuck article.
 */

import { isRecord } from "../util/parse";
import { isTemporaryId } from "./ids";

export const NOTEBOOK_ID_REMAPPED_EVENT = "edgeever:notebook-id-remapped";
export const MEMO_ID_REMAPPED_EVENT = "edgeever:memo-id-remapped";

/** A queued create is flushed immediately; 30s is the ceiling before giving up. */
export const DEFAULT_REMAP_TIMEOUT_MS = 30_000;
/**
 * The event carries the fast path; polling is the safety net. One read per
 * second keeps a stuck queue from hammering the host's notebook list.
 */
export const DEFAULT_REMAP_POLL_MS = 1_000;

export interface RemapEvent {
  name: string;
  /** The cloud id this event announces for our temporary id, or null. */
  read: (detail: unknown) => string | null;
}

export interface RemoteIdWait {
  temporaryId: string;
  /** Reads the durable id from the workspace; null while it is still temporary. */
  lookup: () => Promise<string | null>;
  events?: readonly RemapEvent[];
}

export type RemoteIdWaiter = (wait: RemoteIdWait) => Promise<string | null>;

export interface RemoteIdWaitSettings {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Defaults to the plugin's own window; tests pass a stand-in. */
  eventTarget?: () => RemapEventTarget | null;
}

interface RemapEventTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent?(event: Event): boolean;
}

/**
 * The host's web sync worker reuses an in-flight run instead of starting a new
 * one, so a create queued during that run can sit until some later trigger.
 * Re-announcing the host's own queue-changed event on each poll asks for
 * another pass; the host ignores it while a run is active, so this is cheap.
 */
export const SYNC_QUEUE_CHANGED_EVENT = "edgeever:sync-queue-changed";

const requestQueueFlush = (element: RemapEventTarget | null): void => {
  if (!element?.dispatchEvent || typeof CustomEvent === "undefined") return;
  try {
    element.dispatchEvent(new CustomEvent(SYNC_QUEUE_CHANGED_EVENT));
  } catch {
    // A host that rejects the event still gets the polling half of the wait.
  }
};

/**
 * Plugins run in the host window, so `window` is shared. Hosts without a DOM
 * (or a future sandbox) simply get the polling half of the wait.
 */
const browserWindow = (): RemapEventTarget | null => {
  const scope = globalThis as { window?: RemapEventTarget };
  return typeof scope.window === "undefined" ? null : scope.window ?? null;
};

export function notebookRemapEvents(temporaryId: string): RemapEvent[] {
  return [
    {
      name: NOTEBOOK_ID_REMAPPED_EVENT,
      read: (detail) => {
        if (!isRecord(detail)) return null;
        const { temporaryId: announced, remoteId } = detail;
        return announced === temporaryId && typeof remoteId === "string" ? remoteId : null;
      },
    },
  ];
}

export function noteRemapEvents(temporaryId: string): RemapEvent[] {
  return [
    {
      name: MEMO_ID_REMAPPED_EVENT,
      read: (detail) => {
        if (!isRecord(detail) || typeof detail.get !== "function") return null;
        const remoteId = (detail as unknown as Map<string, string>).get(temporaryId);
        return typeof remoteId === "string" ? remoteId : null;
      },
    },
  ];
}

export function createRemoteIdWaiter(overrides: RemoteIdWaitSettings = {}): RemoteIdWaiter {
  const timeoutMs = Math.max(0, overrides.timeoutMs ?? DEFAULT_REMAP_TIMEOUT_MS);
  const intervalMs = Math.max(1, Math.trunc(overrides.intervalMs ?? DEFAULT_REMAP_POLL_MS));
  const sleep = overrides.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = overrides.now ?? (() => Date.now());
  const eventTarget = overrides.eventTarget ?? browserWindow;
  // A frozen or coarse clock must not spin forever.
  const maxRounds = Math.ceil(timeoutMs / intervalMs) + 2;

  return async ({ temporaryId, lookup, events = [] }) => {
    if (!isTemporaryId(temporaryId)) return temporaryId;
    const element = eventTarget();
    let announced: string | null = null;
    const listener = (event: Event) => {
      const spec = events.find((candidate) => candidate.name === event.type);
      if (!spec) return;
      const remoteId = spec.read((event as CustomEvent).detail);
      if (remoteId && !isTemporaryId(remoteId)) announced = remoteId;
    };
    try {
      for (const spec of events) element?.addEventListener(spec.name, listener);
      const started = now();
      for (let round = 0; round <= maxRounds; round += 1) {
        if (announced) return announced;
        const remoteId = await lookup().catch(() => null);
        if (remoteId && !isTemporaryId(remoteId)) return remoteId;
        // An event that arrived while the lookup was in flight wins.
        if (announced) return announced;
        if (now() - started >= timeoutMs) return null;
        requestQueueFlush(element);
        await sleep(intervalMs);
      }
      return announced;
    } finally {
      for (const spec of events) element?.removeEventListener(spec.name, listener);
    }
  };
}

export const defaultRemoteIdWaiter = createRemoteIdWaiter();
