import type { PluginContext, PluginNotebook } from "../edgeever";
import { cleanNotebookSegment } from "../template/render";
import { isTemporaryId, TemporaryIdTimeoutError } from "./ids";
import { defaultRemoteIdWaiter, notebookRemapEvents, type RemoteIdWaiter } from "./remap";

export const FALLBACK_ROOT_NOTEBOOK = "笔记同步助手";
export const MAX_NOTEBOOK_DEPTH = 12;

/** Turns a rendered folder template into notebook names; empty or unsafe segments are dropped. */
export function splitNotebookPath(rendered: string): string[] {
  return rendered
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map(cleanNotebookSegment)
    .filter((segment) => segment.length > 0)
    .slice(0, MAX_NOTEBOOK_DEPTH);
}

export type NotebookRepository = PluginContext["notebooks"];

/**
 * Creates the notebook tree a folder template asks for, matching on
 * (parent, name) so repeated runs never duplicate a level.
 *
 * The host is local-first: `create` returns a device-only id and queues the
 * server call. Every level must therefore wait for its cloud id before it can
 * be used as the parent of the next level (or of a note) — a queued child
 * still pointing at a temporary id is rejected by the server forever.
 */
export class NotebookResolver {
  private notebooks: PluginNotebook[] = [];
  private loaded = false;

  constructor(
    private readonly repository: NotebookRepository,
    private readonly waitForRemoteId: RemoteIdWaiter = defaultRemoteIdWaiter,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    this.notebooks = await this.repository.list();
    this.loaded = true;
  }

  /**
   * A remapped notebook may briefly coexist with its temporary twin in the
   * local mirror, so a cloud id always wins over a temporary match.
   */
  private find(parentId: string | null, name: string): PluginNotebook | undefined {
    const matches = this.notebooks.filter(
      (notebook) => (notebook.parentId ?? null) === parentId && notebook.name === name,
    );
    return matches.find((notebook) => !isTemporaryId(notebook.id)) ?? matches[0];
  }

  private remember(remoteId: string, temporaryId: string, parentId: string | null, name: string): void {
    this.notebooks = this.notebooks.filter((notebook) => notebook.id !== temporaryId);
    if (!this.notebooks.some((notebook) => notebook.id === remoteId)) {
      this.notebooks.push({ id: remoteId, parentId, name, memoCount: 0 });
    }
  }

  private async requireCloudId(notebookId: string, parentId: string | null, name: string): Promise<string> {
    if (!isTemporaryId(notebookId)) return notebookId;
    const remoteId = await this.waitForRemoteId({
      temporaryId: notebookId,
      lookup: async () => {
        // Re-read the workspace instead of trusting the cache: the host swaps
        // the local row when the queued create is accepted.
        await this.refresh().catch(() => undefined);
        return this.find(parentId, name)?.id ?? null;
      },
      events: notebookRemapEvents(notebookId),
    });
    if (!remoteId) throw new TemporaryIdTimeoutError();
    this.remember(remoteId, notebookId, parentId, name);
    return remoteId;
  }

  async ensure(renderedPath: string): Promise<string> {
    const segments = splitNotebookPath(renderedPath);
    const path = segments.length ? segments : [FALLBACK_ROOT_NOTEBOOK];
    await this.load();
    let parentId: string | null = null;
    for (const segment of path) {
      const existing = this.find(parentId, segment);
      if (existing) {
        parentId = await this.requireCloudId(existing.id, parentId, segment);
        continue;
      }
      const created = await this.repository.create({ name: segment, parentId });
      if (!this.notebooks.some((notebook) => notebook.id === created.id)) this.notebooks.push(created);
      parentId = await this.requireCloudId(created.id, parentId, segment);
    }
    return parentId as string;
  }
}
