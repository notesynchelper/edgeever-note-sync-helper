import type { PluginContext } from "../edgeever";
import { decodedFilename } from "./links";
import { getFallbackUrls } from "./fallback";
import { parseUrl } from "../util/parse";

export type Transport = "direct" | "public";
export type DownloadFailureKind = "permanent" | "transient" | "too_large";

/** The host adds a `transport` switch on top of the usual request init. */
export type TransportFetch = PluginContext["network"]["fetch"];

export interface DownloadedImage {
  ok: true;
  data: Uint8Array;
  mimeType: string;
  extension: string;
  filename: string;
  transport: Transport;
  url: string;
  attempts: number;
}

export interface DownloadFailure {
  ok: false;
  kind: DownloadFailureKind;
  error: string;
  attempts: number;
}

export type DownloadResult = DownloadedImage | DownloadFailure;

export interface ImageDownloadOptions {
  fetchImpl: TransportFetch;
  /** Cap for a single download. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** The host relay refuses anything above 2 MB. */
const PUBLIC_MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const PUBLIC_TIMEOUT_MS = 15_000;
const TOTAL_BUDGET_MS = 25_000;
/**
 * Per-transport attempt budgets. The public relay only succeeds for hosts
 * without CORS headers, so it gets reserved slots that a long mirror list can
 * never crowd out. Direct attempts always run first.
 */
const MAX_DIRECT_ATTEMPTS = 4;
const MAX_PUBLIC_ATTEMPTS = 2;

/** Statuses that will not change on retry, regardless of mirror or transport. */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 410]);

interface Attempt {
  url: string;
  transport: Transport;
}

class AttemptError extends Error {
  constructor(message: string, readonly kind: DownloadFailureKind) {
    super(message);
  }
}

const headerValue = (headers: Headers, name: string): string => headers.get(name) || "";

function tailContains(bytes: Uint8Array, sequence: readonly number[], windowSize: number): boolean {
  const start = Math.max(0, bytes.length - windowSize);
  for (let offset = start; offset <= bytes.length - sequence.length; offset += 1) {
    if (sequence.every((value, index) => bytes[offset + index] === value)) return true;
  }
  return false;
}

const PNG_END = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | null;

export function sniffImageFormat(bytes: Uint8Array): ImageFormat {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  const head = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 256))).replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return null;
}

/**
 * Rejects truncated images (half-saved screenshots are a real failure mode) and
 * HTML error pages served with an image extension.
 */
export function isCompleteImage(bytes: Uint8Array, format: ImageFormat): boolean {
  if (!bytes.length) return false;
  switch (format) {
    case "png":
      return tailContains(bytes, PNG_END, 64);
    case "jpeg":
      return tailContains(bytes, [0xff, 0xd9], 64);
    case "gif":
      return tailContains(bytes, [0x3b], 64);
    case "webp": {
      if (bytes.length < 12) return false;
      const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
      return declared >= 4 && declared + 8 <= bytes.length;
    }
    case "bmp": {
      if (bytes.length < 6) return false;
      const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true);
      return declared > 0 && declared <= bytes.length;
    }
    case "svg":
      return new TextDecoder().decode(bytes.slice(Math.max(0, bytes.length - 512))).toLowerCase().includes("</svg>");
    default:
      return true;
  }
}

interface FormatInfo {
  mimeType: string;
  extension: string;
}

const FORMAT_INFO: Record<Exclude<ImageFormat, null>, FormatInfo> = {
  png: { mimeType: "image/png", extension: "png" },
  jpeg: { mimeType: "image/jpeg", extension: "jpg" },
  gif: { mimeType: "image/gif", extension: "gif" },
  webp: { mimeType: "image/webp", extension: "webp" },
  bmp: { mimeType: "image/bmp", extension: "bmp" },
  svg: { mimeType: "image/svg+xml", extension: "svg" },
};

/** File extensions a URL can honestly advertise, mapped to the one we store. */
const EXTENSION_BY_URL_SUFFIX: Record<string, string> = {
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
  svg: "svg",
};

function extensionFromUrl(url: string): string {
  const match = parseUrl(url)?.pathname.match(/\.([a-z0-9]{1,5})$/i);
  return match ? match[1].toLowerCase() : "";
}

export function filenameFor(url: string, extension: string): string {
  const name = decodedFilename(url, "");
  if (!name) return `image.${extension}`;
  return name.includes(".") ? name : `${name}.${extension}`;
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = headerValue(response.headers, "content-length");
  if (/^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new AttemptError("图片超过大小上限", "too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new AttemptError("图片超过大小上限", "too_large");
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AttemptError("图片超过大小上限", "too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const SIZE_LIMIT_MESSAGE = /size limit|too large|2 ?MB/i;

/** The relay reports its size cap by throwing; normalise that into our own kind. */
function normalizePublicError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : "";
  return SIZE_LIMIT_MESSAGE.test(message) ? new AttemptError("图片超过大小上限", "too_large") : error;
}

function buildAttempts(url: string): Attempt[] {
  const candidates = [url, ...getFallbackUrls(url)].filter((value, index, list) => list.indexOf(value) === index);
  return [
    ...candidates.slice(0, MAX_DIRECT_ATTEMPTS).map((candidate) => ({ url: candidate, transport: "direct" as const })),
    // Only the most likely mirrors are retried through the relay, but those
    // slots are reserved: CORS-blocked hosts only ever load through it.
    ...candidates.slice(0, MAX_PUBLIC_ATTEMPTS).map((candidate) => ({ url: candidate, transport: "public" as const })),
  ];
}

export async function downloadImage(url: string, options: ImageDownloadOptions): Promise<DownloadResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const publicMaxBytes = Math.min(PUBLIC_MAX_BYTES, maxBytes);
  const attempts = buildAttempts(url);
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  const fetchOnce = async (attempt: Attempt, signal: AbortSignal): Promise<Response> => {
    try {
      return await options.fetchImpl(attempt.url, { method: "GET", transport: attempt.transport, signal });
    } catch (error) {
      throw attempt.transport === "public" ? normalizePublicError(error) : error;
    }
  };

  let count = 0;
  let sawTooLarge = false;
  let sawPermanent = false;
  let lastError = "图片下载失败";

  for (const attempt of attempts) {
    if (Date.now() > deadline) {
      lastError = "图片下载超时";
      break;
    }
    count += 1;
    const budget = attempt.transport === "public" ? publicMaxBytes : maxBytes;
    const signal = AbortSignal.timeout(attempt.transport === "public" ? PUBLIC_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetchOnce(attempt, signal);
      if (!response.ok) {
        const status = response.status;
        if (PERMANENT_STATUSES.has(status)) {
          sawPermanent = true;
          lastError = `图片地址不可用（${status}）`;
        } else {
          lastError = `图片请求失败（${status}）`;
        }
        continue;
      }
      const bytes = await readLimited(response, budget);
      const format = sniffImageFormat(bytes);
      if (!format) {
        sawPermanent = true;
        lastError = "返回内容不是图片";
        continue;
      }
      if (!isCompleteImage(bytes, format)) {
        lastError = "图片内容不完整";
        continue;
      }
      const declaredType = headerValue(response.headers, "content-type").split(";")[0].trim().toLowerCase();
      const info = FORMAT_INFO[format];
      const mimeType = declaredType.startsWith("image/") ? declaredType : info.mimeType;
      const extension = EXTENSION_BY_URL_SUFFIX[extensionFromUrl(attempt.url)] ?? info.extension;
      return {
        ok: true,
        data: bytes,
        mimeType,
        extension,
        filename: filenameFor(attempt.url, extension),
        transport: attempt.transport,
        url: attempt.url,
        attempts: count,
      };
    } catch (error) {
      if (error instanceof AttemptError) {
        if (error.kind === "too_large") sawTooLarge = true;
        if (error.kind === "permanent") sawPermanent = true;
        lastError = error.message;
      } else if (signal.aborted) {
        lastError = "图片下载超时";
      } else {
        lastError = "图片下载失败";
      }
    }
  }

  const kind: DownloadFailureKind = sawTooLarge ? "too_large" : sawPermanent ? "permanent" : "transient";
  return { ok: false, kind, error: lastError, attempts: count };
}
