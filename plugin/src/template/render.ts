import type { RemoteItem } from "../api/types";
import { buildContext, buildPathContext } from "./context";
import { renderTemplate, type TemplateWarning } from "./helpers";

export const MAX_NOTE_TITLE_LENGTH = 160;
export const MAX_NOTEBOOK_NAME_LENGTH = 160;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const TITLE_FORBIDDEN = /[/\\:*?"<>|]/g;

export function renderContent(item: RemoteItem, template: string, datePattern = "yyyy-MM-dd", onWarning?: TemplateWarning): string {
  return renderTemplate(template, buildContext(item, datePattern, "content", onWarning));
}

export function renderPath(item: RemoteItem, template: string, datePattern = "yyyy-MM-dd", onWarning?: TemplateWarning): string {
  return renderTemplate(template, buildPathContext(item, datePattern, onWarning));
}

interface NameRules {
  maxLength: number;
  forbidden?: RegExp;
  replacement?: string;
}

/** One cleaning pass for both notebook names and note titles; they differ only in rules. */
function sanitizeName(value: string, rules: NameRules): string {
  let cleaned = value.replace(CONTROL_CHARS, " ");
  if (rules.forbidden) cleaned = cleaned.replace(rules.forbidden, rules.replacement ?? " ");
  return Array.from(cleaned.replace(/\s+/g, " ").trim()).slice(0, rules.maxLength).join("");
}

export function cleanTitle(rendered: string): string {
  return sanitizeName(rendered, { maxLength: MAX_NOTE_TITLE_LENGTH, forbidden: TITLE_FORBIDDEN });
}

/** Note titles are a database field; the host refuses anything above 160 characters. */
export function safeNoteTitle(rendered: string, remoteId: string): string {
  return cleanTitle(rendered) || `无标题-${remoteId.slice(0, 8)}`;
}

/** Path separators are already replaced in the path context; a stray backslash can still arrive from a template literal. */
export function cleanNotebookSegment(segment: string): string {
  return sanitizeName(segment, { maxLength: MAX_NOTEBOOK_NAME_LENGTH, forbidden: /\\/g, replacement: "／" });
}
