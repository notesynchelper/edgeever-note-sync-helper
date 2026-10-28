import type {
  PluginContext,
  PluginNote,
  PluginNotebook,
  PluginResource,
  PluginScheduleInput,
  PluginSettingValue,
} from "../../src/edgeever";
import { hashText } from "../../src/util/hash";

export interface FakeHostState {
  notices: string[];
  notes: Map<string, PluginNote>;
  notebooks: PluginNotebook[];
  resources: Array<{ noteId: string; filename: string; size: number; type: string }>;
  storage: Map<string, unknown>;
  settings: Map<string, PluginSettingValue>;
  schedules: PluginScheduleInput[];
  removedSchedules: string[];
  createCalls: number;
  updateCalls: number;
  moveCalls: Array<{ noteIds: string[]; notebookId: string }>;
  settingsChangedListeners: Array<(payload: { key: string }) => void>;
  disposed: boolean;
  /** Temporary → cloud ids the host has already swapped (as `repository.getMemo` does). */
  idMappings: Map<string, string>;
  /** One host sync round: applies every remap that is due. */
  tick(): void;
  /** Applies every pending remap regardless of its due round. */
  remapAll(): void;
  /** Remaps still waiting for their host round. */
  pendingRemaps: Array<{ temporaryId: string; remoteId: string; kind: "notebook" | "note"; dueTick: number }>;
}

export interface FakeHostOptions {
  settings?: Record<string, PluginSettingValue>;
  fetchImpl?: (input: string, init?: RequestInit & { transport?: "direct" | "public" }) => Promise<Response>;
  notebooks?: PluginNotebook[];
  /** When true, schedule calls reject like the web host does. */
  schedulesUnavailable?: boolean;
  /**
   * Simulates the local-first host: `create` answers with a device-only id and
   * the cloud id only appears `ticksBeforeRemap` sync rounds later (null = the
   * queue never flushes).
   */
  localFirst?: { ticksBeforeRemap: number | null };
}

const nowIso = () => new Date("2026-10-28T00:00:00.000Z").toISOString();

export function createFakeHost(options: FakeHostOptions = {}): { context: PluginContext; state: FakeHostState } {
  const state: FakeHostState = {
    notices: [],
    notes: new Map(),
    notebooks: [...(options.notebooks ?? [])],
    resources: [],
    storage: new Map(),
    settings: new Map(Object.entries(options.settings ?? {})),
    schedules: [],
    removedSchedules: [],
    createCalls: 0,
    updateCalls: 0,
    moveCalls: [],
    settingsChangedListeners: [],
    disposed: false,
    idMappings: new Map(),
    pendingRemaps: [],
    tick() {
      remapTicks += 1;
      applyRemaps(false);
    },
    remapAll() {
      applyRemaps(true);
    },
  };

  let noteSeq = 0;
  let notebookSeq = 100;
  let resourceSeq = 0;
  const localFirst = options.localFirst;
  let remapTicks = 0;

  /** Mirrors the host: the queue replaces the local row and announces the swap. */
  const applyRemaps = (force: boolean) => {
    const due = state.pendingRemaps.filter((entry) => force || entry.dueTick <= remapTicks);
    if (due.length === 0) return;
    state.pendingRemaps = state.pendingRemaps.filter((entry) => !due.includes(entry));
    const noteRemaps = new Map<string, string>();
    for (const entry of due) {
      state.idMappings.set(entry.temporaryId, entry.remoteId);
      if (entry.kind === "notebook") {
        state.notebooks = state.notebooks.map((notebook) =>
          notebook.id === entry.temporaryId ? { ...notebook, id: entry.remoteId } : notebook);
      } else {
        const note = state.notes.get(entry.temporaryId);
        if (note) {
          state.notes.delete(entry.temporaryId);
          state.notes.set(entry.remoteId, { ...note, id: entry.remoteId });
        }
        noteRemaps.set(entry.temporaryId, entry.remoteId);
      }
    }
    const scope = globalThis as { window?: EventTarget };
    if (!scope.window) return;
    for (const entry of due) {
      if (entry.kind === "notebook") {
        scope.window.dispatchEvent(new CustomEvent("edgeever:notebook-id-remapped", {
          detail: { temporaryId: entry.temporaryId, remoteId: entry.remoteId },
        }));
      }
    }
    if (noteRemaps.size > 0) {
      scope.window.dispatchEvent(new CustomEvent("edgeever:memo-id-remapped", { detail: noteRemaps }));
    }
  };

  const scheduleRemap = (temporaryId: string, remoteId: string, kind: "notebook" | "note") => {
    if (!localFirst) return;
    state.pendingRemaps.push({
      temporaryId,
      remoteId,
      kind,
      dueTick: localFirst.ticksBeforeRemap === null ? Number.POSITIVE_INFINITY : remapTicks + localFirst.ticksBeforeRemap,
    });
  };

  /** The host answers a temporary id with the cloud note once it has swapped them. */
  const resolveId = (noteId: string): string => state.idMappings.get(noteId) ?? noteId;

  const notes = {
    async queryContent(input: { limit?: number; offset?: number; sort?: string } = {}) {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
      const offset = Math.max(input.offset ?? 0, 0);
      const all = [...state.notes.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const notes = all.slice(offset, offset + limit);
      return {
        notes,
        totalCount: all.length,
        nextOffset: offset + notes.length < all.length ? offset + notes.length : null,
      };
    },
    async get(noteId: string) {
      const note = state.notes.get(resolveId(noteId));
      if (!note) throw Object.assign(new Error("Note not found"), { status: 404 });
      return note;
    },
    async create(input: { notebookId: string; title?: string; contentMarkdown?: string; tags?: string[] }) {
      state.createCalls += 1;
      const sequence = ++noteSeq;
      const remoteId = `note-${sequence}`;
      const note: PluginNote = {
        kind: "text",
        id: localFirst ? `local_note-${sequence}` : remoteId,
        notebookId: resolveId(input.notebookId),
        title: input.title ?? null,
        tags: [...(input.tags ?? [])],
        contentMarkdown: input.contentMarkdown ?? "",
        contentText: input.contentMarkdown ?? "",
        contentHash: await hashText(input.contentMarkdown ?? ""),
        revision: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.notes.set(note.id, note);
      scheduleRemap(note.id, remoteId, "note");
      return note;
    },
    async update(noteId: string, input: { title?: string; contentMarkdown?: string; tags?: string[] }) {
      const resolvedId = resolveId(noteId);
      const note = state.notes.get(resolvedId);
      if (!note) throw Object.assign(new Error("Note not found"), { status: 404 });
      state.updateCalls += 1;
      const updated: PluginNote = {
        ...note,
        title: input.title ?? note.title,
        tags: input.tags ?? note.tags,
        contentMarkdown: input.contentMarkdown ?? note.contentMarkdown,
        revision: note.revision + 1,
      };
      updated.contentHash = await hashText(updated.contentMarkdown);
      state.notes.set(resolvedId, updated);
      return updated;
    },
    async move(noteIds: string[], notebookId: string) {
      state.moveCalls.push({ noteIds, notebookId });
      for (const noteId of noteIds) {
        const resolvedId = resolveId(noteId);
        const note = state.notes.get(resolvedId);
        if (note) state.notes.set(resolvedId, { ...note, notebookId: resolveId(notebookId) });
      }
      return noteIds.length;
    },
  };

  const context: PluginContext = {
    pluginId: "com.bijitongbu.note-sync-helper",
    notes,
    notebooks: {
      async list() {
        return [...state.notebooks];
      },
      async create(input: { name: string; parentId?: string | null }) {
        const sequence = ++notebookSeq;
        const remoteId = `nb-${sequence}`;
        const notebook: PluginNotebook = {
          id: localFirst ? `local_nb-${sequence}` : remoteId,
          parentId: input.parentId ?? null,
          name: input.name,
          memoCount: 0,
        };
        state.notebooks.push(notebook);
        scheduleRemap(notebook.id, remoteId, "notebook");
        return notebook;
      },
    },
    resources: {
      async upload(noteId: string, file: File): Promise<PluginResource> {
        state.resources.push({ noteId, filename: file.name, size: file.size, type: file.type });
        const id = `res-${++resourceSeq}`;
        return {
          id,
          noteId,
          kind: "image",
          mimeType: file.type || null,
          filename: file.name,
          byteSize: file.size,
          width: null,
          height: null,
          url: `/api/v1/resources/${id}/blob`,
        };
      },
    },
    commands: {
      register(command) {
        return () => {
          state.disposed = true;
          void command;
        };
      },
    },
    schedules: {
      async upsert(input) {
        if (options.schedulesUnavailable) throw new Error("Plugin schedules are only available in the EdgeEver desktop app.");
        state.schedules.push(input);
        return { ...input, isEnabled: true, runsOnThisDevice: true } as never;
      },
      async list() {
        throw new Error("not used");
      },
      async remove(key) {
        if (options.schedulesUnavailable) throw new Error("Plugin schedules are only available in the EdgeEver desktop app.");
        state.removedSchedules.push(key);
      },
    },
    events: {
      on(_event, listener) {
        state.settingsChangedListeners.push(listener);
        return () => {
          const index = state.settingsChangedListeners.indexOf(listener);
          if (index >= 0) state.settingsChangedListeners.splice(index, 1);
        };
      },
    },
    storage: {
      async get<T>(key: string) {
        return (state.storage.has(key) ? (state.storage.get(key) as T) : null);
      },
      async set<T>(key: string, value: T) {
        state.storage.set(key, value);
      },
      async remove(key: string) {
        state.storage.delete(key);
      },
    },
    settings: {
      async get(key: string) {
        return state.settings.has(key) ? state.settings.get(key)! : null;
      },
      async set(key: string, value: PluginSettingValue) {
        state.settings.set(key, value);
      },
    },
    network: {
      async fetch(input, init) {
        if (!options.fetchImpl) throw new TypeError("network disabled in this fake");
        return options.fetchImpl(input, init);
      },
    },
    ui: {
      showNotice(message: string) {
        state.notices.push(message);
      },
    },
  };

  return { context, state };
}
