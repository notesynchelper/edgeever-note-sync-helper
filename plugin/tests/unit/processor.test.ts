import { beforeEach, describe, expect, test } from "vitest";
import { processItem, renderNote, type ProcessOutcome } from "../../src/sync/processor";
import { NotebookResolver } from "../../src/sync/notebooks";
import { cleanIndex, type NoteIndex } from "../../src/sync/dedupe";
import { normalizeSettings, type PluginSettings } from "../../src/settings";
import { hashText } from "../../src/util/hash";
import { ImageLocalizer, type ImageResourceMap, type PendingNotes } from "../../src/resources/localizer";
import { createFakeHost, type FakeHostState } from "../helpers/fakeHost";
import { makeItem, PNG_BYTES } from "../helpers/fixtures";
import type { PluginContext } from "../../src/edgeever";

interface Harness {
  context: PluginContext;
  state: FakeHostState;
  index: NoteIndex;
  settings: PluginSettings;
  notebooks: NotebookResolver;
  persistIndex: () => Promise<void>;
  run: (item: ReturnType<typeof makeItem>, localizer?: ImageLocalizer) => Promise<ProcessOutcome>;
}

function harness(overrides: Partial<PluginSettings> = {}): Harness {
  const { context, state } = createFakeHost();
  const index: NoteIndex = cleanIndex({});
  const settings = { ...normalizeSettings({}), ...overrides };
  const notebooks = new NotebookResolver(context.notebooks);
  const persistIndex = async () => {
    await context.storage.set("sync.index", index);
  };
  return {
    context,
    state,
    index,
    settings,
    notebooks,
    persistIndex,
    run: (item, localizer) => processItem({
      item,
      settings,
      index,
      notes: context.notes,
      notebooks,
      localizer,
      hash: hashText,
      findNoteBySourceId: async () => null,
      persistIndex,
    }),
  };
}

function localizer(options: {
  download?: (url: string) => Promise<any>;
  upload?: (noteId: string, file: File) => Promise<{ url: string }>;
  maps?: Record<string, ImageResourceMap>;
  pending?: PendingNotes;
} = {}): {
  instance: ImageLocalizer;
  uploads: Array<{ noteId: string; name: string; type: string }>;
  pendingData: PendingNotes;
} {
  const uploads: Array<{ noteId: string; name: string; type: string }> = [];
  const maps = options.maps ?? {};
  const pendingData = options.pending ?? {};
  const instance = new ImageLocalizer({
    download: options.download ?? (async () => ({
      ok: true,
      data: PNG_BYTES,
      mimeType: "image/png",
      extension: "png",
      filename: "abc123.png",
      transport: "direct" as const,
      url: "https://relay-1.bijitongbu.site/p/abc123.png",
      attempts: 1,
    })),
    upload: options.upload ?? (async (noteId, file) => {
      uploads.push({ noteId, name: file.name, type: file.type });
      return { url: `/api/v1/resources/res-${uploads.length}/blob` };
    }),
    loadMap: async (noteId) => maps[noteId] ?? {},
    saveMap: async (noteId, map) => {
      maps[noteId] = map;
    },
    loadPending: async () => pendingData,
    savePending: async () => undefined,
    maxAttempts: 3,
  });
  return { instance, uploads, pendingData };
}

describe("processItem", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  test("creates the notebook path, note and index entry", async () => {
    const item = makeItem();
    const outcome = await h.run(item);
    expect(outcome.action).toBe("created");
    expect(h.state.notebooks.map((notebook) => notebook.name)).toEqual(["笔记同步助手", expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]);
    const note = [...h.state.notes.values()][0];
    expect(note.title).toBe(item.title);
    expect(note.contentMarkdown.startsWith("---\n")).toBe(true);
    expect(note.contentMarkdown).toContain(`notehelper-id: "${item.id}"`);
    expect(note.contentMarkdown).toContain("正文第一段。");
    expect(note.tags).toEqual(["笔记同步助手", "效率工具"]);
    expect(h.index[item.id].noteId).toBe(note.id);
    expect(h.index[item.id].writtenHash).toHaveLength(64);
    expect(h.state.storage.get("sync.index")).toBe(h.index);
  });

  test("a second identical run only skips", async () => {
    const item = makeItem();
    await h.run(item);
    const before = h.state.updateCalls;
    const outcome = await h.run(item);
    expect(outcome.action).toBe("skipped");
    expect(h.state.createCalls).toBe(1);
    expect(h.state.updateCalls).toBe(before);
    expect(h.state.notes.size).toBe(1);
  });

  test("a changed article updates the existing note in place", async () => {
    const item = makeItem();
    await h.run(item);
    const changed = makeItem({ updatedAt: "2026-10-29T09:00:00.000Z", title: "新标题", content: "全新的正文。" });
    const outcome = await h.run(changed);
    expect(outcome.action).toBe("updated");
    expect(h.state.notes.size).toBe(1);
    const note = [...h.state.notes.values()][0];
    expect(note.title).toBe("新标题");
    expect(note.contentMarkdown).toContain("全新的正文。");
    expect(note.contentMarkdown).not.toContain("正文第一段。");
  });

  test("a user-edited note is preserved and counted as skipped", async () => {
    const item = makeItem();
    await h.run(item);
    const note = [...h.state.notes.values()][0];
    await h.context.notes.update(note.id, { contentMarkdown: `${note.contentMarkdown}\n\n我自己的补充。` });
    const changed = makeItem({ updatedAt: "2026-10-30T00:00:00.000Z", content: "服务端的新正文。" });
    const outcome = await h.run(changed);
    expect(outcome.action).toBe("skipped");
    expect(h.state.notes.size).toBe(1);
    const after = [...h.state.notes.values()][0];
    expect(after.contentMarkdown).toContain("我自己的补充。");
    expect(after.contentMarkdown).not.toContain("服务端的新正文。");
    // The article timestamp is still recorded so the next run does not re-read it.
    expect(h.index[item.id].remoteUpdatedAt).toBe("2026-10-30T00:00:00.000Z");
  });

  test("recreates the note when it was deleted in the workspace", async () => {
    const item = makeItem();
    await h.run(item);
    const note = [...h.state.notes.values()][0];
    h.state.notes.delete(note.id);
    const changed = makeItem({ updatedAt: "2026-10-30T00:00:00.000Z" });
    const outcome = await h.run(changed);
    expect(outcome.action).toBe("created");
    expect(h.state.notes.size).toBe(1);
    expect(h.index[item.id].noteId).not.toBe(note.id);
  });

  test("never overwrites a note adopted without a recorded hash when the index is gone", async () => {
    const item = makeItem();
    await h.run(item);
    const note = [...h.state.notes.values()][0];
    await h.context.notes.update(note.id, { contentMarkdown: `${note.contentMarkdown}\n\n我自己的补充。` });
    const edited = [...h.state.notes.values()][0].contentMarkdown;
    h.index = cleanIndex({});
    const outcome = await processItem({
      item: makeItem({ updatedAt: "2026-10-30T00:00:00.000Z", title: "改过的标题" }),
      settings: h.settings,
      index: h.index,
      notes: h.context.notes,
      notebooks: h.notebooks,
      hash: hashText,
      findNoteBySourceId: async (sourceId) => (sourceId === item.id ? note.id : null),
      persistIndex: h.persistIndex,
    });
    // A rebuilt index entry cannot prove the note is ours, so it counts as user-edited.
    expect(outcome.action).toBe("skipped");
    expect(h.state.notes.size).toBe(1);
    const after = [...h.state.notes.values()][0];
    expect(after.title).toBe(item.title);
    expect(after.contentMarkdown).toBe(edited);
    // The article timestamp is still recorded so the next run does not re-read it.
    expect(h.index[item.id].remoteUpdatedAt).toBe("2026-10-30T00:00:00.000Z");
  });

  test("counts distinct remote image URLs when images are not localised", async () => {
    const item = makeItem({
      content: [
        "![a](https://relay-1.bijitongbu.site/p/abc123.png)",
        "![b](https://relay-1.bijitongbu.site/p/abc123.png)",
        "![c](https://pbs.twimg.com/media/x.jpg)",
      ].join("\n\n"),
    });
    const outcome = await h.run({ ...item, labels: [] });
    expect(outcome.action).toBe("created");
    expect(outcome.imagesRemote).toBe(2);
    expect(outcome.imagesLocal).toBe(0);
  });

  test("template changes rewrite existing notes without duplicating them", async () => {
    const item = makeItem();
    await h.run(item);
    h.settings.articleTemplate = "> 由笔记同步助手整理\n\n{{{content}}}";
    const outcome = await h.run(item);
    expect(outcome.action).toBe("updated");
    expect(h.state.notes.size).toBe(1);
    expect([...h.state.notes.values()][0].contentMarkdown).toContain("> 由笔记同步助手整理");
  });

  test("moves a note when the folder template points somewhere else", async () => {
    const item = makeItem();
    await h.run(item);
    h.settings.folderTemplate = "笔记同步助手/归档/{{{yearSaved}}}";
    const outcome = await h.run(item);
    expect(outcome.action).toBe("updated");
    expect(h.state.moveCalls).toHaveLength(1);
    const target = h.state.notebooks.find((notebook) => notebook.id === h.state.moveCalls[0].notebookId);
    expect(target?.name).toBe("2026");
  });

  test("localises images on create and rewrites the body through an update", async () => {
    const local = localizer();
    const outcome = await h.run(makeItem(), local.instance);
    expect(outcome.action).toBe("created");
    expect(outcome.imagesLocal).toBe(1);
    expect(local.uploads).toHaveLength(1);
    const note = [...h.state.notes.values()][0];
    expect(note.contentMarkdown).toContain("/api/v1/resources/res-1/blob");
    expect(note.contentMarkdown).not.toContain("relay-1.bijitongbu.site/p/abc123.png");
    // The recorded hash must describe what was finally written, not the first draft.
    expect(h.index[makeItem().id].writtenHash).toBe(await hashText(note.contentMarkdown));
    // A following run sees a clean note and does nothing.
    expect((await h.run(makeItem(), local.instance)).action).toBe("skipped");
  });

  test("a failed image rewrite is retried instead of being marked done", async () => {
    const local = localizer();
    const originalUpdate = h.context.notes.update;
    let failOnce = true;
    h.context.notes.update = async (noteId, input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("workspace unavailable");
      }
      return originalUpdate(noteId, input);
    };
    await expect(h.run(makeItem(), local.instance)).rejects.toThrow();
    expect(h.index[makeItem().id].renderedHash).toBe("");

    const outcome = await h.run(makeItem(), local.instance);
    expect(outcome.action).toBe("updated");
    expect([...h.state.notes.values()][0].contentMarkdown).toContain("/api/v1/resources/");
  });

  test("keeps the remote link when an image cannot be saved", async () => {
    const local = localizer({
      download: async () => ({ ok: false, kind: "permanent", error: "not an image", attempts: 1 }),
    });
    const outcome = await h.run(makeItem(), local.instance);
    expect(outcome.action).toBe("created");
    expect(outcome.imagesRemote).toBe(1);
    expect([...h.state.notes.values()][0].contentMarkdown).toContain("relay-1.bijitongbu.site/p/abc123.png");
  });

  test("re-uses an already stored image instead of uploading it again", async () => {
    const maps: Record<string, ImageResourceMap> = {};
    const first = localizer({ maps });
    await h.run(makeItem(), first.instance);
    const noteId = [...h.state.notes.values()][0].id;
    expect(maps[noteId]).toBeTruthy();
    const second = localizer({ maps, upload: async () => ({ url: "/should-not-happen" }) });
    const changed = makeItem({ updatedAt: "2026-10-31T00:00:00.000Z", content: "新正文。\n\n![图一](https://relay-1.bijitongbu.site/p/abc123.png)" });
    await h.run(changed, second.instance);
    expect(second.uploads).toHaveLength(0);
    expect([...h.state.notes.values()][0].contentMarkdown).toContain("/api/v1/resources/res-1/blob");
  });
});

describe("renderNote", () => {
  test("renders folder, title and body from one article", async () => {
    const item = makeItem();
    const rendered = await renderNote(item, normalizeSettings({}), hashText);
    expect(rendered.notebookPath).toMatch(/^笔记同步助手\/\d{4}-\d{2}-\d{2}$/);
    expect(rendered.title).toBe(item.title);
    expect(rendered.markdown).toContain("notehelper-id");
    expect(rendered.imageCount).toBe(1);
    expect(rendered.renderedHash).toHaveLength(64);
  });
});
