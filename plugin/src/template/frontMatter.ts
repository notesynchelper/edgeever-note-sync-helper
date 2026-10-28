import YAML from "yaml";
import type { RemoteItem } from "../api/types";
import { renderContent } from "./render";
import type { TemplateWarning } from "./helpers";
import { frontMatterLines } from "../settings";

/**
 * Stable marker kept in the note's own properties block. It is what lets a
 * lost local index be rebuilt from the workspace itself (see docs/DESIGN.md).
 */
export const SOURCE_ID_FIELD = "notehelper-id";

export interface RenderedFrontMatter {
  /** Complete YAML body without the `---` fences. */
  yaml: string;
  tags: string[];
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ANCHOR_LINE = new RegExp(`^\\s*${escapeRegExp(SOURCE_ID_FIELD)}\\s*:`, "i");
const ANCHOR_VALUE = new RegExp(
  `^\\s*${escapeRegExp(SOURCE_ID_FIELD)}\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)'|([^\\s#]+))\\s*(?:#.*)?$`,
  "i",
);

export function escapeYamlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}

export function tagNames(value: unknown): string[] {
  const input = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(input.map((item) => String(item).trim()).filter(Boolean))];
}

/** Parses the rendered block only to lift tag names; malformed YAML is left for the host to show. */
export function extractTags(yaml: string): string[] {
  if (!yaml.trim()) return [];
  try {
    const parsed = YAML.parse(yaml);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return tagNames((parsed as Record<string, unknown>).tags);
  } catch {
    return [];
  }
}

/**
 * Renders the properties template and always appends the source marker, even
 * when the template is empty. Any marker the template itself produced is
 * dropped first so repeated renders stay idempotent.
 */
export function buildFrontMatter(
  item: RemoteItem,
  template: string,
  datePattern = "yyyy-MM-dd",
  onWarning?: TemplateWarning,
): RenderedFrontMatter {
  const rendered = renderContent(item, frontMatterLines(template), datePattern, onWarning);
  const kept = rendered
    .split(/\r?\n/)
    .filter((line) => !ANCHOR_LINE.test(line))
    .join("\n")
    .trim();
  const anchor = `${SOURCE_ID_FIELD}: "${escapeYamlString(item.id)}"`;
  const yaml = kept ? `${kept}\n${anchor}` : anchor;
  return { yaml, tags: extractTags(yaml) };
}

export function composeMarkdown(yaml: string, body: string): string {
  const trimmed = body.replace(/\s+$/, "");
  return trimmed ? `---\n${yaml}\n---\n\n${trimmed}` : `---\n${yaml}\n---\n`;
}

const FRONT_MATTER_BLOCK = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Reads the marker back out of a note. Used only when the local index is missing. */
export function extractSourceId(markdown: string): string | null {
  const block = FRONT_MATTER_BLOCK.exec(markdown);
  if (!block) return null;
  for (const line of block[1].split(/\r?\n/)) {
    const match = ANCHOR_VALUE.exec(line);
    if (!match) continue;
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    const value = raw.replace(/\\(["\\])/g, "$1").trim();
    if (value) return value;
  }
  return null;
}
