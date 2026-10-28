import { afterEach, describe, expect, test } from "vitest";
import { endpointCandidates, OFFICIAL_BASES, parseDevEndpoint } from "../../src/api/endpoints";
import { ArticleClient } from "../../src/api/client";
import type { PluginContext } from "../../src/edgeever";
import { ImageLocalizer, type ImageResourceMap, type PendingNotes } from "../../src/resources/localizer";
import { normalizeSettings, type PluginSettings } from "../../src/settings";
import { cleanIndex, type NoteIndex } from "../../src/sync/dedupe";
import { isTemporaryId, TemporaryIdTimeoutError } from "../../src/sync/ids";
import { NotebookResolver } from "../../src/sync/notebooks";
import { processItem } from "../../src/sync/processor";
import {
  createRemoteIdWaiter,
  noteRemapEvents,
  notebookRemapEvents,
  type RemoteIdWaiter,
} from "../../src/sync/remap";
import { STORAGE_KEYS, SyncService } from "../../src/sync/service";
import { USER_FACING_TEXT } from "../../src/ui/text";
import { hashText } from "../../src/util/hash";
import { createFakeHost, type FakeHostState } from "../helpers/fakeHost";
import { makeItem, PNG_BYTES } from "../helpers/fixtures";

function clock() {
  let value = 0;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

/** A waiter whose "sleep" is one host sync round; no real timers in tests. */
function hostDrivenWaiter(state: FakeHostState, time = clock()): RemoteIdWaiter {
  const waiter = createRemoteIdWaiter({
    intervalMs: 100,
    timeoutMs: 1_000,
    now: time.now,
    sleep: async (ms) => {
      time.advance(ms);
      state.tick();
    },
  });
  return (wait) => waiter(wait);
}

function imageLocalizer(uploads: Array<{ noteId: string }> = []): ImageLocalizer {
  const maps: Record<string, ImageResourceMap> = {};
  const pending: PendingNotes = {};
  return new ImageLocalizer({
    download: async () => ({
      ok: true,
      data: PNG_BYTES,
      mimeType: "image/png",
      extension: "png",
      filename: "abc123.png",
      transport: "direct" as const,
      url: "https://relay-1.bijitongbu.site/p/abc123.png",
      attempts: 1,
    }),
    upload: async (noteId) => {
      uploads.push({ noteId });
      return { url: `/api/v1/resources/res-${uploads.length}/blob` };
    },
    loadMap: async (noteId) => maps[noteId] ?? {},
    saveMap: async (noteId, map) => {
      maps[noteId] = map;
    },
    loadPending: async () => pending,
    savePending: async () => undefined,
  });
}

interface Harness {
  context: PluginContext;
  state: FakeHostState;
  index: NoteIndex;
  settings: PluginSettings;
  notebooks: NotebookResolver;
  persistIndex: () => Promise<void>;
  run: (item: ReturnType<typeof makeItem>, localizer?: ImageLocalizer) => Promise<unknown>;
}

function harness(options: { localFirst?: { ticksBeforeRemap: number | null } } = {}): Harness {
  const { context, state } = createFakeHost(options);
  const index: NoteIndex = cleanIndex({});
  const settings = normalizeSettings({});
  const waiter = hostDrivenWaiter(state);
  const notebooks = new NotebookResolver(context.notebooks, waiter);
  const persistIndex = async () => {
    await context.storage.set(STORAGE_KEYS.index, index);
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
      waitForRemoteId: waiter,
    }),
  };
}

const searchResponse = (items: Array<{ id: string; title: string; updatedAt: string; content?: string }> = []): Response =>
  new Response(JSON.stringify({
    edges: items.map((item) => ({
      node: {
        id: item.id,
        title: item.title,
        savedAt: "2026-10-01T00:00:00.000Z",
        updatedAt: item.updatedAt,
        content: item.content ?? "正文",
      },
    })),
    pageInfo: { hasNextPage: false },
  }), { status: 200, headers: { "content-type": "application/json" } });

/**
 * Notebooks land in the cloud immediately; notes stay in the local mirror until
 * the queue drains. This is the half of the local-first host that used to lose
 * articles, isolated from the notebook wait.
 */
function noteLocalHarness(): Harness {
  const h = harness();
  let notebookSeq = 800;
  h.context.notebooks.create = async (input) => {
    const notebook = {
      id: `nb-${++notebookSeq}`,
      parentId: input.parentId ?? null,
      name: input.name,
      memoCount: 0,
    };
    h.state.notebooks.push(notebook);
    return notebook;
  };
  const create = h.context.notes.create;
  h.context.notes.create = async (input) => {
    const note = await create(input);
    h.state.notes.delete(note.id);
    const temporary = { ...note, id: `local_${note.id}` };
    h.state.notes.set(temporary.id, temporary);
    return temporary;
  };
  return h;
}

afterEach(() => {
  delete (globalThis as { window?: EventTarget }).window;
});

describe("temporary ids", () => {
  test("recognises the web and desktop device-only prefixes", () => {
    expect(isTemporaryId("local_6f0a")).toBe(true);
    expect(isTemporaryId("nb_local_6f0a")).toBe(true);
    expect(isTemporaryId("memo_local_6f0a")).toBe(true);
    expect(isTemporaryId("b606b493-ced9")).toBe(false);
    expect(isTemporaryId("")).toBe(false);
    expect(isTemporaryId(undefined)).toBe(false);
  });

  test("the host event alone is enough to resolve a notebook id", async () => {
    const target = new EventTarget();
    (globalThis as { window?: EventTarget }).window = target;
    const time = clock();
    const waiter = createRemoteIdWaiter({
      intervalMs: 10,
      timeoutMs: 100,
      now: time.now,
      eventTarget: () => target,
      sleep: async (ms) => {
        time.advance(ms);
        target.dispatchEvent(new CustomEvent("edgeever:notebook-id-remapped", {
          detail: { temporaryId: "local_nb-1", remoteId: "nb-1" },
        }));
      },
    });
    const remote = await waiter({
      temporaryId: "local_nb-1",
      lookup: async () => null,
      events: notebookRemapEvents("local_nb-1"),
    });
    expect(remote).toBe("nb-1");
  });

  test("each poll asks the host to flush its sync queue again", async () => {
    const target = new EventTarget();
    let flushes = 0;
    target.addEventListener("edgeever:sync-queue-changed", () => { flushes += 1; });
    const time = clock();
    let reads = 0;
    const waiter = createRemoteIdWaiter({
      intervalMs: 10,
      timeoutMs: 100,
      now: time.now,
      eventTarget: () => target,
      sleep: async (ms) => { time.advance(ms); },
    });
    const remote = await waiter({
      temporaryId: "local_nb-2",
      lookup: async () => (++reads >= 3 ? "nb-2" : null),
      events: notebookRemapEvents("local_nb-2"),
    });
    expect(remote).toBe("nb-2");
    expect(flushes).toBe(2);
  });

  test("a memo remap map resolves through the same event", async () => {
    const target = new EventTarget();
    const time = clock();
    const waiter = createRemoteIdWaiter({
      intervalMs: 10,
      timeoutMs: 100,
      now: time.now,
      eventTarget: () => target,
      sleep: async (ms) => {
        time.advance(ms);
        target.dispatchEvent(new CustomEvent("edgeever:memo-id-remapped", {
          detail: new Map([["local_note-2", "note-2"]]),
        }));
      },
    });
    const remote = await waiter({
      temporaryId: "local_note-2",
      lookup: async () => null,
      events: noteRemapEvents("local_note-2"),
    });
    expect(remote).toBe("note-2");
  });

  test("gives up after the budget when the host never swaps the id", async () => {
    const time = clock();
    const waiter = createRemoteIdWaiter({
      intervalMs: 100,
      timeoutMs: 1_000,
      now: time.now,
      eventTarget: () => null,
      sleep: async (ms) => time.advance(ms),
    });
    const remote = await waiter({ temporaryId: "local_nb-9", lookup: async () => null });
    expect(remote).toBeNull();
  });
});

describe("notebooks on a local-first host", () => {
  test("waits for each level and passes the cloud id as the next parent", async () => {
    const h = harness({ localFirst: { ticksBeforeRemap: 1 } });
    const created: Array<{ name: string; parentId?: string | null }> = [];
    const create = h.context.notebooks.create;
    h.context.notebooks.create = async (input) => {
      created.push({ name: input.name, parentId: input.parentId });
      return create(input);
    };
    const rootId = await h.notebooks.ensure("笔记同步助手/2026-10-28");
    expect(isTemporaryId(rootId)).toBe(false);
    expect(created.map((call) => call.parentId)).toEqual([null, "nb-101"]);
    expect(h.state.notebooks.map((notebook) => notebook.id)).toEqual(["nb-101", "nb-102"]);
    const leaf = h.state.notebooks.find((notebook) => notebook.name === "2026-10-28");
    expect(leaf?.parentId).toBe("nb-101");
  });

  test("a notebook that never reaches the cloud fails the article", async () => {
    const h = harness({ localFirst: { ticksBeforeRemap: null } });
    await expect(h.run(makeItem())).rejects.toBeInstanceOf(TemporaryIdTimeoutError);
  });
});

describe("notes on a local-first host", () => {
  test("images are uploaded to the cloud note, not the temporary one", async () => {
    const h = harness({ localFirst: { ticksBeforeRemap: 1 } });
    const uploads: Array<{ noteId: string }> = [];
    const outcome = await h.run(makeItem(), imageLocalizer(uploads));
    expect(outcome).toMatchObject({ action: "created", imagesLocal: 1 });
    expect(uploads).toHaveLength(1);
    expect(isTemporaryId(uploads[0].noteId)).toBe(false);
    expect(h.index[makeItem().id].noteId).toBe("note-1");
    expect([...h.state.notes.values()][0].contentMarkdown).toContain("/api/v1/resources/res-1/blob");
  });

  test("a note that never reaches the cloud fails instead of reporting success", async () => {
    const h = noteLocalHarness();
    await expect(h.run(makeItem())).rejects.toBeInstanceOf(TemporaryIdTimeoutError);
    // The temporary id is still recorded so the next run can heal the entry.
    expect(isTemporaryId(h.index[makeItem().id].noteId)).toBe(true);
  });

  test("the next run resolves a stored temporary id before writing", async () => {
    const h = noteLocalHarness();
    await expect(h.run(makeItem())).rejects.toBeInstanceOf(TemporaryIdTimeoutError);
    const temporaryId = h.index[makeItem().id].noteId;
    // The host drains its queue while the user is away.
    h.state.pendingRemaps.push({ temporaryId, remoteId: "note-1", kind: "note", dueTick: 0 });
    h.state.remapAll();

    const changed = makeItem({ updatedAt: "2026-10-29T00:00:00.000Z", content: "新的正文。" });
    const outcome = await h.run(changed);
    expect(outcome).toMatchObject({ action: "updated" });
    expect(h.index[makeItem().id].noteId).toBe("note-1");
    expect(h.state.notes.size).toBe(1);
    expect(h.state.createCalls).toBe(1);
  });
});

describe("service on a local-first host", () => {
  test("an unflushed queue keeps the cursor back and says so", async () => {
    const { context, state } = createFakeHost({
      settings: { "api-key": "test-key" },
      fetchImpl: async () => searchResponse([{ id: "a1", title: "第一篇", updatedAt: "2026-10-27T10:00:00.000Z" }]),
      localFirst: { ticksBeforeRemap: null },
    });
    const lastRun = await new SyncService({ context, waiter: hostDrivenWaiter(state) }).run();
    expect(lastRun.ok).toBe(false);
    expect(state.notices.at(-1)).toBe(`同步失败：${USER_FACING_TEXT.reasons.stillSaving}`);
    expect(state.storage.get(STORAGE_KEYS.cursor)).toBeUndefined();
  });

  test("a written note still held locally is reported as unfinished", async () => {
    let content = "第一版正文";
    const { context, state } = createFakeHost({
      settings: { "api-key": "test-key" },
      fetchImpl: async () => searchResponse([{ id: "a1", title: "第一篇", updatedAt: "2026-10-27T10:00:00.000Z", content }]),
    });
    const create = context.notes.create;
    context.notes.create = async (input) => {
      const note = await create(input);
      state.notes.delete(note.id);
      const temporary = { ...note, id: `local_${note.id}` };
      state.notes.set(temporary.id, temporary);
      return temporary;
    };
    const waiter = hostDrivenWaiter(state);
    // First run: the wait times out, so the index keeps the temporary id.
    await new SyncService({ context, waiter }).run();
    content = "第二版正文";
    const lastRun = await new SyncService({ context, waiter }).run();
    expect(lastRun.ok).toBe(false);
    expect(state.notices.at(-1)).toBe(`同步失败：${USER_FACING_TEXT.reasons.stillSaving}`);
    expect(state.storage.get(STORAGE_KEYS.cursor)).toBeUndefined();
  });
});

describe("sync.devEndpoint", () => {
  test("accepts only loopback HTTP bases with an explicit port", () => {
    expect(parseDevEndpoint("http://127.0.0.1:19341")).toBe("http://127.0.0.1:19341");
    expect(parseDevEndpoint("http://localhost:19341/")).toBe("http://localhost:19341");
    expect(parseDevEndpoint(" http://127.0.0.1:19341 ")).toBe("http://127.0.0.1:19341");
    expect(parseDevEndpoint("https://127.0.0.1:19341")).toBeNull();
    expect(parseDevEndpoint("http://127.0.0.1")).toBeNull();
    expect(parseDevEndpoint("http://127.0.0.1:19341/api/graphql")).toBeNull();
    expect(parseDevEndpoint("http://192.168.1.5:19341")).toBeNull();
    expect(parseDevEndpoint("http://localhost:19341?x=1")).toBeNull();
    expect(parseDevEndpoint("http://user:pw@localhost:19341")).toBeNull();
    expect(parseDevEndpoint("https://relay-1.bijitongbu.site/helper")).toBeNull();
    expect(parseDevEndpoint(undefined)).toBeNull();
    expect(parseDevEndpoint(42)).toBeNull();
  });

  test("goes first in the candidate list and keeps the official order behind it", () => {
    const urls = endpointCandidates(undefined, "http://127.0.0.1:19341");
    expect(urls[0]).toBe("http://127.0.0.1:19341/api/graphql");
    expect(urls.slice(1)).toEqual(OFFICIAL_BASES.map((base) => `${base}/api/graphql`));
    expect(endpointCandidates(undefined, "https://evil.example")).toEqual(
      OFFICIAL_BASES.map((base) => `${base}/api/graphql`),
    );
  });

  test("a sync through the development entry point does not cache it", async () => {
    const seen: string[] = [];
    const { context, state } = createFakeHost({
      settings: { "api-key": "test-key" },
      fetchImpl: async (url) => {
        seen.push(url);
        return searchResponse([]);
      },
    });
    state.storage.set(STORAGE_KEYS.devEndpoint, "http://127.0.0.1:19341");
    const lastRun = await new SyncService({ context }).run();
    expect(lastRun.ok).toBe(true);
    expect(seen[0]).toBe("http://127.0.0.1:19341/api/graphql");
    expect(state.storage.get(STORAGE_KEYS.endpoint)).toBeUndefined();
  });

  test("ignores a development value that is not loopback", async () => {
    const seen: string[] = [];
    const { context, state } = createFakeHost({
      settings: { "api-key": "test-key" },
      fetchImpl: async (url) => {
        seen.push(url);
        return searchResponse([]);
      },
    });
    state.storage.set(STORAGE_KEYS.devEndpoint, "https://elsewhere.example");
    await new SyncService({ context }).run();
    expect(seen[0]).toBe(`${OFFICIAL_BASES[0]}/api/graphql`);
  });

  test("falls through to the official entry points when the mock is down", async () => {
    const seen: string[] = [];
    const client = new ArticleClient({
      apiKey: "k",
      devEndpoint: "http://127.0.0.1:19341",
      fetchImpl: async (url) => {
        seen.push(url);
        if (url.startsWith("http://127.0.0.1:19341")) throw new TypeError("Failed to fetch");
        return searchResponse([]);
      },
    });
    const result = await client.fetchAll();
    expect(seen).toHaveLength(2);
    expect(result.endpoint).toBe(`${OFFICIAL_BASES[0]}/api/graphql`);
  });
});
