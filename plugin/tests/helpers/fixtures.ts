import type { ValidatedItem } from "../../src/api/types";

export function makeItem(overrides: Partial<ValidatedItem> = {}): ValidatedItem {
  return {
    id: "b606b493-ced9-4344-a061-aca748948ee4",
    title: "被 Obsidian 反复劝退？可能是你的打开姿势不对",
    url: "https://mp.weixin.qq.com/s?__biz=example",
    originalArticleUrl: "https://mp.weixin.qq.com/s?__biz=example",
    author: "笔记同步助手",
    siteName: "微信公众号",
    savedAt: "2026-10-28T08:13:22.686076+08:00",
    updatedAt: "2026-10-28T08:13:22.686076+08:00",
    publishedAt: "2026-10-27T10:00:00.000+08:00",
    wordsCount: 1200,
    readingProgressPercent: 0,
    isArchived: false,
    pageType: "ARTICLE",
    labels: [{ id: "l1", name: "效率工具" }],
    content: "正文第一段。\n\n![图一](https://relay-1.bijitongbu.site/p/abc123.png)\n\n结尾。",
    ...overrides,
  } as ValidatedItem;
}

/** Minimal but structurally complete PNG: signature, IHDR, IEND. */
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** Truncated PNG: signature only, no IEND. */
export const TRUNCATED_PNG = PNG_BYTES.slice(0, 16);

export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);

export function imageResponse(bytes: Uint8Array = PNG_BYTES, type = "image/png", status = 200): Response {
  return new Response(bytes as unknown as BodyInit, {
    status,
    headers: { "content-type": type, "content-length": String(bytes.byteLength) },
  });
}

export function htmlResponse(status = 200): Response {
  return new Response("<!doctype html><html><body>404</body></html>", {
    status,
    headers: { "content-type": "text/html" },
  });
}
