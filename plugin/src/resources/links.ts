import { parseUrl } from "../util/parse";

export interface ImageReference {
  url: string;
  label: string;
  originalText: string;
  filename: string;
}

export function isRemoteUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && (parsed.protocol === "http:" || parsed.protocol === "https:");
}

/** Decoded last path segment, safe to use as a file name. */
export function decodedFilename(url: string, fallback: string): string {
  const segment = parseUrl(url)?.pathname.split("/").filter(Boolean).pop();
  if (!segment) return fallback;
  try {
    return decodeURIComponent(segment).replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 180) || fallback;
  } catch {
    return fallback;
  }
}

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*(?:<)?(https?:\/\/[^\s)>]+)(?:>)?(?:\s+["'][^)]*["'])?\s*\)/gi;
const HTML_IMAGE = /<img\b[^>]*\bsrc\s*=\s*(["'])(https?:\/\/[^"']+)\1[^>]*>/gi;

/** Every remote image the rendered body points at, markdown or inline HTML. */
export function extractImageReferences(body: string): ImageReference[] {
  const references: ImageReference[] = [];
  for (const match of body.matchAll(MARKDOWN_IMAGE)) {
    const url = match[2];
    if (!isRemoteUrl(url)) continue;
    references.push({
      url,
      label: match[1] || "",
      originalText: match[0],
      filename: decodedFilename(url, "image"),
    });
  }
  for (const match of body.matchAll(HTML_IMAGE)) {
    const url = match[2];
    if (!isRemoteUrl(url)) continue;
    const alt = match[0].match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2] || "";
    references.push({
      url,
      label: alt,
      originalText: match[0],
      filename: decodedFilename(url, "image"),
    });
  }
  return references;
}

const escapeLabel = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replace(/[[\]\r\n]/g, (character) => (character === "\r" || character === "\n" ? " " : `\\${character}`));

/** Same shape the host itself produces when a resource is inserted into Markdown. */
export function imageMarkdown(label: string, url: string): string {
  const safeUrl = url.replaceAll("(", "%28").replaceAll(")", "%29");
  return `![${escapeLabel(label || "image")}](${safeUrl})`;
}

export function rewriteImageReferences(
  body: string,
  references: readonly ImageReference[],
  replacements: ReadonlyMap<string, string>,
): string {
  let rewritten = body;
  for (const reference of references) {
    const local = replacements.get(reference.url);
    if (!local) continue;
    rewritten = rewritten.split(reference.originalText).join(imageMarkdown(reference.label, local));
  }
  return rewritten;
}
