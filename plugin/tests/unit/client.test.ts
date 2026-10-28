import { describe, expect, test } from "vitest";
import { ArticleClient } from "../../src/api/client";
import { endpointCandidates, OFFICIAL_BASES } from "../../src/api/endpoints";
import { ApiRequestError } from "../../src/api/types";

function node(id: string, updatedAt = "2026-10-28T12:00:00.000Z") {
  return {
    id,
    title: `title ${id}`,
    savedAt: "2026-10-01T00:00:00.000Z",
    updatedAt,
    content: `content ${id}`,
  };
}

function page(ids: string[], hasNextPage: boolean) {
  return new Response(JSON.stringify({ edges: ids.map((id) => ({ node: node(id) })), pageInfo: { hasNextPage } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const jsonError = (status: number) => new Response("{}", { status });

describe("article client", () => {
  test("paginates by the number of items actually returned", async () => {
    const calls: Array<{ endpoint: string; after: number; query: string }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ endpoint: url, after: body.variables.after, query: body.variables.query });
      if (body.variables.after === 0) return page(["a", "b"], true);
      return page(["c"], false);
    };
    const client = new ArticleClient({ apiKey: "k", fetchImpl, pageSize: 5 });
    const result = await client.fetchAll("");
    expect(result.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(calls.map((call) => call.after)).toEqual([0, 2]);
    expect(calls[0].query).toBe("sort:saved-asc");
    expect(calls[0].endpoint).toBe(`${OFFICIAL_BASES[0]}/api/graphql`);
  });

  test("sends the cursor as an inclusive lower bound", async () => {
    let query = "";
    const client = new ArticleClient({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        query = JSON.parse(String(init?.body)).variables.query;
        return page([], false);
      },
    });
    await client.fetchAll("2026-10-26T14:50:33.852Z");
    expect(query).toBe("updated:2026-10-26T14:50:33.852Z sort:saved-asc");
  });

  test("moves to the next entry point on transport failures only", async () => {
    const seen: string[] = [];
    const client = new ArticleClient({
      apiKey: "k",
      fetchImpl: async (url) => {
        seen.push(url);
        if (url.startsWith(OFFICIAL_BASES[0])) return jsonError(502);
        return page(["a"], false);
      },
    });
    const result = await client.fetchAll();
    expect(result.items).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(result.endpoint.startsWith(OFFICIAL_BASES[1])).toBe(true);
  });

  test("retries the next entry point when the network throws", async () => {
    const client = new ArticleClient({
      apiKey: "k",
      fetchImpl: async (url) => {
        if (url.startsWith(OFFICIAL_BASES[0])) throw new TypeError("Failed to fetch");
        return page(["a"], false);
      },
    });
    await expect(client.fetchAll()).resolves.toMatchObject({ items: [{ id: "a" }] });
  });

  test("does not rotate entry points on an application error", async () => {
    const seen: string[] = [];
    const client = new ArticleClient({
      apiKey: "k",
      fetchImpl: async (url) => {
        seen.push(url);
        return jsonError(500);
      },
    });
    await expect(client.fetchAll()).rejects.toMatchObject({ kind: "app_5xx" });
    expect(seen).toHaveLength(1);
  });

  test("does not fall back when the key is rejected", async () => {
    const seen: string[] = [];
    const client = new ArticleClient({
      apiKey: "bad",
      fetchImpl: async (url) => {
        seen.push(url);
        return jsonError(401);
      },
    });
    await expect(client.fetchAll()).rejects.toMatchObject({ kind: "business", status: 401 });
    expect(seen).toHaveLength(1);
  });

  test("an empty page that still claims a next page is an error, not a loop", async () => {
    const client = new ArticleClient({
      apiKey: "k",
      fetchImpl: async () => page([], true),
    });
    await expect(client.fetchAll()).rejects.toBeInstanceOf(ApiRequestError);
  });

  test("rejects payloads without the fields sync depends on", async () => {
    const client = new ArticleClient({
      apiKey: "k",
      fetchImpl: async () => new Response(JSON.stringify({ edges: [{ node: { id: "x" } }], pageInfo: { hasNextPage: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(client.fetchAll()).rejects.toMatchObject({ kind: "gateway" });
  });

  test("rejects a GraphQL error array", async () => {
    const client = new ArticleClient({
      apiKey: "k",
      fetchImpl: async () => new Response(JSON.stringify({ errors: [{ message: "nope" }] }), { status: 200 }),
    });
    await expect(client.fetchAll()).rejects.toMatchObject({ kind: "gateway" });
  });

  test("requires a key before any request", async () => {
    let called = false;
    const client = new ArticleClient({
      apiKey: "  ",
      fetchImpl: async () => {
        called = true;
        return page([], false);
      },
    });
    await expect(client.fetchAll()).rejects.toMatchObject({ kind: "business" });
    expect(called).toBe(false);
  });

  test("displays a friendly message for a timeout", async () => {
    const client = new ArticleClient({
      apiKey: "k",
      timeoutMs: 1,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });
    await expect(client.fetchAll()).rejects.toMatchObject({ kind: "network" });
  });

  test("prefers the cached entry point but never trusts a foreign URL", async () => {
    const seen: string[] = [];
    const client = new ArticleClient({
      apiKey: "k",
      preferredEndpoint: OFFICIAL_BASES[2],
      fetchImpl: async (url) => {
        seen.push(url);
        return page([], false);
      },
    });
    await client.fetchAll();
    expect(seen[0].startsWith(OFFICIAL_BASES[2])).toBe(true);

    const foreign: string[] = [];
    const hostile = new ArticleClient({
      apiKey: "k",
      preferredEndpoint: "https://attacker.example",
      fetchImpl: async (url) => {
        foreign.push(url);
        return page([], false);
      },
    });
    await hostile.fetchAll();
    expect(foreign.every((url) => !url.includes("attacker"))).toBe(true);
    expect(endpointCandidates("https://attacker.example")[0]).toBe(`${OFFICIAL_BASES[0]}/api/graphql`);
  });
});
