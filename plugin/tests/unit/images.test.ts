import { describe, expect, test } from "vitest";
import { downloadImage } from "../../src/resources/downloader";
import { getFallbackUrls } from "../../src/resources/fallback";
import { extractImageReferences, imageMarkdown, rewriteImageReferences } from "../../src/resources/links";
import { ImageLocalizer, type ImageResourceMap, type PendingNotes } from "../../src/resources/localizer";
import { PNG_BYTES, TRUNCATED_PNG, imageResponse, htmlResponse } from "../helpers/fixtures";

const RELAY_PNG = "https://relay-1.bijitongbu.site/p/abc123.png";

describe("image downloader", () => {
  test("uses the direct transport when the host allows it", async () => {
    const calls: Array<{ url: string; transport?: string }> = [];
    const result = await downloadImage(RELAY_PNG, {
      fetchImpl: async (url, init) => {
        calls.push({ url, transport: init?.transport });
        return imageResponse();
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transport).toBe("direct");
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("abc123.png");
    expect(calls).toHaveLength(1);
  });

  test("falls back to the public transport when the browser blocks the request", async () => {
    const transports: string[] = [];
    const result = await downloadImage(RELAY_PNG, {
      fetchImpl: async (_url, init) => {
        transports.push(init?.transport ?? "direct");
        if (init?.transport !== "public") throw new TypeError("Failed to fetch");
        return imageResponse();
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transport).toBe("public");
    expect(transports).toContain("public");
  });

  test("tries a mirror before giving up", async () => {
    const seen: string[] = [];
    const result = await downloadImage(RELAY_PNG, {
      fetchImpl: async (url) => {
        seen.push(url);
        if (url.startsWith("https://relay-1.")) throw new TypeError("down");
        return imageResponse();
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url.startsWith("https://relay-2.")).toBe(true);
    expect(seen.length).toBe(2);
  });

  test("reports a transient failure when every route fails", async () => {
    const result = await downloadImage(RELAY_PNG, {
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(result).toMatchObject({ ok: false, kind: "transient" });
    if (result.ok) return;
    expect(result.attempts).toBe(6);
  });

  test("reserves public-relay attempts after the whole direct list fails", async () => {
    const calls: Array<{ url: string; transport?: string }> = [];
    const result = await downloadImage(RELAY_PNG, {
      fetchImpl: async (url, init) => {
        calls.push({ url, transport: init?.transport ?? "direct" });
        if (init?.transport !== "public") throw new TypeError("Failed to fetch");
        return imageResponse();
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transport).toBe("public");
    expect(calls.filter((call) => call.transport === "direct")).toHaveLength(4);
    expect(calls.at(-1)?.transport).toBe("public");
  });

  test("an HTML error page is never stored as an image", async () => {
    const result = await downloadImage(RELAY_PNG, {
      fetchImpl: async () => htmlResponse(),
    });
    expect(result).toMatchObject({ ok: false, kind: "permanent" });
  });

  test("a truncated image is retried and then reported", async () => {
    const result = await downloadImage(RELAY_PNG, {
      fetchImpl: async () => imageResponse(TRUNCATED_PNG),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("transient");
  });

  test("refuses content above the size limit", async () => {
    const result = await downloadImage(RELAY_PNG, {
      fetchImpl: async () => new Response(PNG_BYTES as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "image/png", "content-length": String(3_000_000) },
      }),
      maxBytes: 1_000_000,
    });
    expect(result).toMatchObject({ ok: false, kind: "too_large" });
  });
});

describe("mirror mapping", () => {
  test("swaps relay hosts and falls back to the image host", () => {
    const urls = getFallbackUrls("https://relay-1.bijitongbu.site/p/abc.png?x=1");
    expect(urls[0]).toBe("https://relay-2.bijitongbu.site/p/abc.png?x=1");
    expect(urls).toContain("https://relay-4.bijitongbu.site/p/abc.png?x=1");
    expect(urls).toContain("https://pic.clipfx.app/abc.png?x=1");
  });

  test("maps the image host back onto every relay", () => {
    const urls = getFallbackUrls("https://pic.clipfx.app/abc.png");
    expect(urls).toHaveLength(3);
    expect(urls.every((url) => url.startsWith("https://relay-"))).toBe(true);
  });

  test("leaves unknown hosts alone", () => {
    expect(getFallbackUrls("https://pbs.twimg.com/media/x.jpg")).toEqual([]);
  });
});

describe("image references", () => {
  test("extracts markdown and html images once each", () => {
    const body = [
      "![a](https://relay-1.bijitongbu.site/p/1.png)",
      '<img src="https://pbs.twimg.com/media/x.jpg" alt="b">',
      "![dup](https://relay-1.bijitongbu.site/p/1.png)",
      "[link](https://example.com/page)",
    ].join("\n\n");
    const refs = extractImageReferences(body);
    expect(refs).toHaveLength(3);
    expect(refs.map((ref) => ref.filename)).toEqual(["1.png", "1.png", "x.jpg"]);
  });

  test("rewrites only the images that were localised", () => {
    const body = "![a](https://relay-1.bijitongbu.site/p/1.png) and ![b](https://x.test/2.png)";
    const refs = extractImageReferences(body);
    const rewritten = rewriteImageReferences(body, refs, new Map([["https://relay-1.bijitongbu.site/p/1.png", "/api/v1/resources/r1/blob"]]));
    expect(rewritten).toContain("![a](/api/v1/resources/r1/blob)");
    expect(rewritten).toContain("![b](https://x.test/2.png)");
  });

  test("produces the same escaping the host uses", () => {
    expect(imageMarkdown("a[b]", "/api/v1/resources/r(1)/blob")).toBe("![a\\[b\\]](/api/v1/resources/r%281%29/blob)");
  });
});

function makeLocalizer(options: {
  download: (url: string) => Promise<any>;
  maps?: Record<string, ImageResourceMap>;
  pending?: PendingNotes;
  maxAttempts?: number;
}) {
  const uploads: string[] = [];
  const maps = options.maps ?? {};
  const pending = options.pending ?? {};
  const instance = new ImageLocalizer({
    download: options.download,
    upload: async (_noteId, file) => {
      uploads.push(file.name);
      return { url: `/api/v1/resources/res-${uploads.length}/blob` };
    },
    loadMap: async (noteId) => maps[noteId] ?? {},
    saveMap: async (noteId, map) => {
      maps[noteId] = map;
    },
    loadPending: async () => pending,
    savePending: async () => undefined,
    maxAttempts: options.maxAttempts ?? 3,
  });
  return { instance, uploads, maps, pending };
}

const ok = () => ({
  ok: true as const,
  data: PNG_BYTES,
  mimeType: "image/png",
  extension: "png",
  filename: "abc123.png",
  transport: "direct" as const,
  url: RELAY_PNG,
  attempts: 1,
});

describe("image localizer", () => {
  test("uploads each image once and remembers the mapping per note", async () => {
    const h = makeLocalizer({ download: async () => ok() });
    const body = `![a](${RELAY_PNG})\n\n![b](https://pbs.twimg.com/media/x.jpg)`;
    const result = await h.instance.localize(body, "note-1");
    expect(result.uploaded).toBe(2);
    expect(h.uploads).toEqual(["abc123.png", "abc123.png"]);
    expect(result.markdown).toContain("/api/v1/resources/res-1/blob");
    expect(result.markdown).toContain("/api/v1/resources/res-2/blob");
    expect(Object.keys(h.maps["note-1"])).toHaveLength(2);

    const again = await h.instance.localize(result.markdown, "note-1");
    expect(again.uploaded).toBe(0);
    expect(h.uploads).toHaveLength(2);
  });

  test("keeps remote links and records permanent failures without retrying", async () => {
    let downloads = 0;
    const h = makeLocalizer({
      download: async () => {
        downloads += 1;
        return { ok: false as const, kind: "permanent" as const, error: "not an image", attempts: 6 };
      },
    });
    const first = await h.instance.localize(`![a](${RELAY_PNG})`, "note-1");
    expect(first.remoteKept).toBe(1);
    expect(first.markdown).toContain(RELAY_PNG);
    expect(h.pending["note-1"].failures[RELAY_PNG].kind).toBe("permanent");

    const second = await h.instance.localize(`![a](${RELAY_PNG})`, "note-1");
    expect(downloads).toBe(1);
    expect(second.remoteKept).toBe(1);
  });

  test("gives up on a transient failure after the attempt budget", async () => {
    let downloads = 0;
    const h = makeLocalizer({
      download: async () => {
        downloads += 1;
        return { ok: false as const, kind: "transient" as const, error: "timeout", attempts: 6 };
      },
      maxAttempts: 2,
    });
    const body = `![a](${RELAY_PNG})`;
    await h.instance.localize(body, "note-1");
    await h.instance.localize(body, "note-1");
    expect(downloads).toBe(2);
    await h.instance.localize(body, "note-1");
    expect(downloads).toBe(2);
  });

  test("a failed upload keeps the remote link and stays retryable", async () => {
    const h = makeLocalizer({ download: async () => ok() });
    const failing = new ImageLocalizer({
      download: async () => ok(),
      upload: async () => {
        throw new Error("upload failed");
      },
      loadMap: async (noteId) => h.maps[noteId] ?? {},
      saveMap: async (noteId, map) => {
        h.maps[noteId] = map;
      },
      loadPending: async () => h.pending,
      savePending: async () => undefined,
    });
    const result = await failing.localize(`![a](${RELAY_PNG})`, "note-1");
    expect(result.failures).toHaveLength(1);
    expect(result.markdown).toContain(RELAY_PNG);
    expect(h.pending["note-1"].failures[RELAY_PNG].kind).toBe("transient");
  });

  test("counts a duplicated remote URL once when it stays remote", async () => {
    const h = makeLocalizer({
      download: async () => ({ ok: false as const, kind: "permanent" as const, error: "not an image", attempts: 1 }),
    });
    const body = `![a](${RELAY_PNG})\n\n![b](${RELAY_PNG})`;
    const result = await h.instance.localize(body, "note-1");
    expect(result.remoteKept).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(h.pending["note-1"].failures[RELAY_PNG].attempts).toBe(1);
    expect("attempts" in h.pending["note-1"]).toBe(false);
  });

  test("does nothing when the body has no images", async () => {
    const h = makeLocalizer({ download: async () => ok() });
    const result = await h.instance.localize("没有图片。", "note-1");
    expect(result).toEqual({ markdown: "没有图片。", uploaded: 0, remoteKept: 0, failures: [] });
    expect(h.uploads).toHaveLength(0);
  });
});
