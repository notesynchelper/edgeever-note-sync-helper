/**
 * Minimal EdgeEver plugin API surface used by this plugin.
 *
 * EdgeEver publishes its plugin types inside the application repository rather
 * than on npm. This file restates only the members this plugin calls, following
 * the public plugin development guide (`docs/plugin-development*.md`). Keeping
 * the surface small makes host upgrades easy to audit.
 */

export type PluginSettingValue = string | number | boolean;

export interface PluginNoteSummary {
  kind: string;
  id: string;
  notebookId: string;
  title: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PluginNote extends PluginNoteSummary {
  contentMarkdown: string;
  contentText: string;
  contentHash: string;
  revision: number;
}

export interface PluginNotebook {
  id: string;
  parentId: string | null;
  name: string;
  memoCount: number;
}

export interface PluginResource {
  id: string;
  noteId: string;
  kind: "image" | "attachment";
  mimeType: string | null;
  filename: string | null;
  byteSize: number;
  width: number | null;
  height: number | null;
  url: string;
}

export interface PluginNoteCreateInput {
  notebookId: string;
  title?: string;
  contentMarkdown?: string;
  tags?: string[];
}

export interface PluginNoteUpdateInput {
  title?: string;
  contentMarkdown?: string;
  tags?: string[];
}

export interface PluginNoteQuery {
  notebookId?: string;
  text?: string;
  tags?: string[];
  sort?: "updated-desc" | "created-desc" | "title-asc" | "title-desc";
  limit?: number;
  offset?: number;
}

export interface PluginNoteQueryResult {
  notes: PluginNoteSummary[];
  totalCount: number;
  nextOffset: number | null;
}

export interface PluginNoteContentQueryResult {
  notes: PluginNote[];
  totalCount: number;
  nextOffset: number | null;
}

export interface PluginCommand {
  id: string;
  title: string;
  listed?: boolean;
  menu?: boolean;
  run: () => void | Promise<void>;
}

export interface PluginScheduleInput {
  key: string;
  name: string;
  commandId: string;
  cronExpression: string;
  timezone?: string;
  missedRunPolicy?: "run-once" | "skip";
  isEnabled?: boolean;
}

export interface PluginSchedule {
  key: string;
  name: string;
  commandId: string;
  cronExpression: string;
  isEnabled: boolean;
  runsOnThisDevice: boolean;
}

export interface PluginContext {
  pluginId: string;
  notes: {
    queryContent(input?: PluginNoteQuery): Promise<PluginNoteContentQueryResult>;
    get(noteId: string): Promise<PluginNote>;
    create(input: PluginNoteCreateInput): Promise<PluginNote>;
    update(noteId: string, input: PluginNoteUpdateInput): Promise<PluginNote>;
    move(noteIds: string[], notebookId: string): Promise<number>;
  };
  notebooks: {
    list(): Promise<PluginNotebook[]>;
    create(input: { name: string; parentId?: string | null }): Promise<PluginNotebook>;
  };
  resources: {
    upload(noteId: string, file: File): Promise<PluginResource>;
  };
  commands: {
    register(command: PluginCommand): () => void;
  };
  schedules: {
    upsert(input: PluginScheduleInput): Promise<PluginSchedule>;
    list(): Promise<PluginSchedule[]>;
    remove(key: string): Promise<void>;
  };
  events: {
    on(event: "settings.changed", listener: (payload: { key: string }) => void): () => void;
  };
  storage: {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
    remove(key: string): Promise<void>;
  };
  settings: {
    get(key: string): Promise<PluginSettingValue | null>;
    set(key: string, value: PluginSettingValue): Promise<void>;
  };
  network: {
    fetch(input: string, init?: RequestInit & { transport?: "direct" | "public" }): Promise<Response>;
  };
  ui: {
    showNotice(message: string): void;
  };
}

export interface EdgeEverPlugin {
  activate(context: PluginContext): void | (() => void) | Promise<void | (() => void)>;
  deactivate?(): void | Promise<void>;
}
