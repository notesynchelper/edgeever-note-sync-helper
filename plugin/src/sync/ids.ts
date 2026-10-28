/**
 * EdgeEver is local-first: creating a notebook or a note writes the local
 * mirror and queues the server call, so the id that comes back belongs to this
 * device only (`local_*` on the web, `nb_local_*` / `memo_local_*` on desktop).
 * Those ids never reach the server, so anything that needs a durable id (child
 * notebooks, note images, the de-duplication index) must wait for the swap.
 */

const TEMPORARY_PREFIXES = ["local_", "nb_local_", "memo_local_"] as const;

export function isTemporaryId(id: unknown): boolean {
  return typeof id === "string" && TEMPORARY_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Raised when the host never turned a temporary id into a cloud id. The
 * article counts as unfinished: the cursor stays back so the next run retries.
 */
export class TemporaryIdTimeoutError extends Error {
  constructor(message = "The host did not publish a cloud id in time") {
    super(message);
    this.name = "TemporaryIdTimeoutError";
  }
}
