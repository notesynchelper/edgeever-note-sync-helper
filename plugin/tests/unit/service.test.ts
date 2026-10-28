import { describe, expect, test } from "vitest";
import { SyncService, STORAGE_KEYS, describeFailure } from "../../src/sync/service";
import { frequencyToCron } from "../../src/main";
import { ApiRequestError, MissingKeyError } from "../../src/api/types";
import { TemplateError } from "../../src/template/helpers";
import { OFFICIAL_BASES } from "../../src/api/endpoints";
import { USER_FACING_TEXT } from "../../src/ui/text";
import { createFakeHost } from "../helpers/fakeHost";

function searchResponse(items: Array<{ id: string; title: string; updatedAt: string; content?: string }>): Response {
  return new Response(JSON.stringify({
    edges: items.map((item) => ({
      node: {
        id: item.id,
        title: item.title,
        savedAt: "2026-10-01T00:00:00.000Z",
        updatedAt: item.updatedAt,
        content: item.content ?? "正文",
        labels: [],
      },
    })),
    pageInfo: { hasNextPage: false },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const ITEMS = [
  { id: "a1", title: "第一篇", updatedAt: "2026-10-27T10:00:00.000Z" },
  { id: "a2", title: "第二篇", updatedAt: "2026-10-28T10:00:00.000Z" },
];

describe("sync service", () => {
  test("refuses to run without a key and reports it", async () => {
    let called = false;
    const { context, state } = createFakeHost({
      fetchImpl: async () => {
        called = true;
        return searchResponse([]);
      },
    });
    const service = new SyncService({ context });
    const lastRun = await service.run();
    expect(called).toBe(false);
    expect(lastRun.ok).toBe(false);
    // Exactly one 「同步失败：」 prefix; the reason itself does not carry it.
    expect(state.notices.at(-1)).toBe("同步失败：请先在插件设置里填写密钥");
    expect(lastRun.error).toBe("请先在插件设置里填写密钥");
    const stored = state.storage.get(STORAGE_KEYS.lastRun) as Record<string, unknown>;
    expect(stored.ok).toBe(false);
    expect(stored.created).toBe(0);
  });

  test("creates notes, records lastRun and advances the cursor", async () => {
    const { context, state } = createFakeHost({
      settings: { "api-key": "test-key" },
      fetchImpl: async () => searchResponse(ITEMS),
    });
    const service = new SyncService({ context });
    const lastRun = await service.run();
    expect(lastRun).toMatchObject({ ok: true, created: 2, updated: 0, skipped: 0 });
    expect(state.notes.size).toBe(2);
    expect(state.notices[0]).toBe("正在同步笔记…");
    expect(state.notices.at(-1)?.startsWith("同步完成")).toBe(true);
    expect(state.storage.get(STORAGE_KEYS.cursor)).toBe("2026-10-28T10:00:00.000Z");
    expect(state.storage.get(STORAGE_KEYS.endpoint)).toBe(`${OFFICIAL_BASES[0]}/api/graphql`);
    const stored = state.storage.get(STORAGE_KEYS.lastRun) as Record<string, unknown>;
    expect(stored).toMatchObject({ ok: true, created: 2, updated: 0, skipped: 0 });
    expect(typeof stored.startedAt).toBe("string");
    expect(typeof stored.finishedAt).toBe("string");
  });

  test("a second run over the same articles changes nothing", async () => {
    const { context, state } = createFakeHost({
      settings: { "api-key": "test-key" },
      fetchImpl: async () => searchResponse(ITEMS),
    });
    const service = new SyncService({ context });
    await service.run();
    const lastRun = await service.run();
    expect(lastRun).toMatchObject({ ok: true, created: 0, updated: 0, skipped: 2 });
    expect(state.notes.size).toBe(2);
    expect(state.createCalls).toBe(2);
  });

  test("does not retry a note's images twice in the same run", async () => {
    const imageUrl = "https://relay-1.bijitongbu.site/p/abc123.png";
    let imageRequests = 0;
    const { context, state } = createFakeHost({
      settings: { "api-key": "test-key" },
      fetchImpl: async (url) => {
        if (url.endsWith("/api/graphql")) {
          return searchResponse([
            { id: "a1", title: "图", updatedAt: "2026-10-27T10:00:00.000Z", content: `![a](${imageUrl})` },
          ]);
        }
        imageRequests += 1;
        throw new TypeError("Failed to fetch");
      },
    });
    const lastRun = await new SyncService({ context }).run();
    expect(lastRun.ok).toBe(true);
    // Exactly one downloadImage call (4 direct + 2 public); the retry pass must
    // skip the note the main loop just handled.
    expect(imageRequests).toBe(6);
    const pending = state.storage.get(STORAGE_KEYS.imagePending) as Record<
      string,
      { failures: Record<string, { attempts: number }> }
    >;
    expect(Object.values(pending)[0].failures[imageUrl].attempts).toBe(1);
  });

  test("a rejected key stops the run without touching the cursor", async () => {
    const { context, state } = createFakeHost({
      settings: { "api-key": "bad" },
      fetchImpl: async () => new Response("{}", { status: 401 }),
    });
    state.storage.set(STORAGE_KEYS.cursor, "2026-10-01T00:00:00.000Z");
    const service = new SyncService({ context });
    const lastRun = await service.run();
    expect(lastRun.ok).toBe(false);
    expect(state.notices.at(-1)).toBe(`同步失败：${USER_FACING_TEXT.reasons.invalidKey}`);
    expect(state.storage.get(STORAGE_KEYS.cursor)).toBe("2026-10-01T00:00:00.000Z");
  });

  test("a failed article keeps the cursor back so the next run retries it", async () => {
    const { context, state } = createFakeHost({
      settings: { "api-key": "test-key" },
      fetchImpl: async () => searchResponse(ITEMS),
    });
    const originalCreate = context.notes.create;
    context.notes.create = async (input) => {
      if (input.title === "第一篇") throw new Error("储存空间不可用");
      return originalCreate(input);
    };
    const service = new SyncService({ context });
    const lastRun = await service.run();
    expect(lastRun).toMatchObject({ ok: false, created: 1 });
    expect(state.notices.at(-1)?.startsWith("同步完成")).toBe(true);
    expect(state.notices.at(-1)).toContain("1 篇未完成");
    expect(state.storage.get(STORAGE_KEYS.cursor)).toBeUndefined();
  });

  test("a broken template fails the run instead of reporting an empty success", async () => {
    const { context, state } = createFakeHost({
      settings: { "api-key": "test-key", "article-template": "{{#unclosed}}" },
      fetchImpl: async () => searchResponse(ITEMS),
    });
    const lastRun = await new SyncService({ context }).run();
    expect(lastRun.ok).toBe(false);
    expect(state.notes.size).toBe(0);
    expect(state.notices.at(-1)).toBe(`同步失败：${USER_FACING_TEXT.reasons.template}`);
  });

  test("never throws, even when the transport explodes", async () => {
    const { context, state } = createFakeHost({
      settings: { "api-key": "test-key" },
      fetchImpl: async () => {
        throw new Error("boom");
      },
    });
    const service = new SyncService({ context });
    const lastRun = await service.run();
    expect(lastRun.ok).toBe(false);
    expect(state.notices.at(-1)?.startsWith("同步失败")).toBe(true);
  });

  test("describeFailure maps internal errors to actionable wording", () => {
    expect(describeFailure(new MissingKeyError())).toBe(USER_FACING_TEXT.reasons.missingKey);
    expect(describeFailure(new ApiRequestError("x", "business"))).toBe(USER_FACING_TEXT.reasons.invalidKey);
    expect(describeFailure(new ApiRequestError("x", "rate_limit"))).toBe(USER_FACING_TEXT.reasons.rateLimited);
    expect(describeFailure(new ApiRequestError("x", "network"))).toBe(USER_FACING_TEXT.reasons.network);
    expect(describeFailure(new ApiRequestError("x", "gateway"))).toBe(USER_FACING_TEXT.reasons.service);
    expect(describeFailure(new TemplateError())).toBe(USER_FACING_TEXT.reasons.template);
    expect(describeFailure(new Error("?"))).toBe(USER_FACING_TEXT.reasons.unknown);
  });
});

describe("schedule conversion", () => {
  test("turns the minute frequency into a cron expression", () => {
    expect(frequencyToCron(0)).toBeNull();
    expect(frequencyToCron(-5)).toBeNull();
    expect(frequencyToCron(15)).toBe("*/15 * * * *");
    expect(frequencyToCron(1)).toBe("*/1 * * * *");
    expect(frequencyToCron(60)).toBe("0 */1 * * *");
    expect(frequencyToCron(180)).toBe("0 */3 * * *");
    expect(frequencyToCron(1440)).toBe("0 0 * * *");
    expect(frequencyToCron(10080)).toBe("0 0 * * *");
  });
});
