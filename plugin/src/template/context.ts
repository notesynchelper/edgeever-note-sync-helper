import type { RemoteItem, RemoteLabel } from "../api/types";
import { formatDate, helperContext, type TemplateWarning } from "./helpers";
import { parseDate, parseUrl } from "../util/parse";

type ContextMode = "path" | "content";

function parts(value?: string): { year: string; month: string; day: string } {
  const date = parseDate(value);
  if (!date) return { year: "", month: "", day: "" };
  return {
    year: formatDate(date, "yyyy"),
    month: formatDate(date, "MM"),
    day: formatDate(date, "dd"),
  };
}

function labelsForMustache(input: RemoteLabel[] = []): RemoteLabel[] {
  const labels = input.map((label) => {
    const value = { ...label } as RemoteLabel & { toString: () => string };
    Object.defineProperty(value, "toString", { enumerable: false, value: () => label.name });
    return value;
  });
  Object.defineProperty(labels, "toString", {
    enumerable: false,
    value: () => labels.map((label) => label.name).join(", "),
  });
  return labels;
}

function stateOf(item: RemoteItem): string {
  if (item.isArchived) return "ARCHIVED";
  if ((item.readingProgressPercent || 0) >= 100) return "COMPLETED";
  if ((item.readingProgressPercent || 0) > 0) return "READING";
  return "INBOX";
}

function siteName(item: RemoteItem): string {
  if (item.siteName) return item.siteName;
  return parseUrl(item.originalArticleUrl || item.url || "")?.hostname ?? "";
}

export function buildContext(
  item: RemoteItem,
  datePattern: string,
  mode: ContextMode,
  onWarning?: TemplateWarning,
): Record<string, any> {
  const saved = parts(item.savedAt);
  const published = parts(item.publishedAt);
  const read = parts(item.readAt);
  const archived = parts(item.archivedAt);
  const updated = parts(item.updatedAt);
  const dateSaved = formatDate(item.savedAt, datePattern);
  const dateArchived = mode === "content" ? (item.archivedAt || "") : formatDate(item.archivedAt || "", datePattern);
  const context: Record<string, any> = {
    id: item.id,
    title: item.title || "",
    author: item.author || "unknown",
    siteName: siteName(item),
    originalUrl: item.originalArticleUrl || item.url || "",
    slug: item.slug || "",
    description: item.description || "",
    content: item.content || "",
    labels: labelsForMustache(item.labels),
    type: item.pageType || "ARTICLE",
    state: stateOf(item),
    wordsCount: item.wordsCount || 0,
    date: dateSaved,
    dateSaved,
    savedAt: item.savedAt || "",
    publishedAt: item.publishedAt || "",
    archivedAt: item.archivedAt || "",
    readAt: item.readAt || "",
    datePublished: item.publishedAt ? formatDate(item.publishedAt, datePattern) : "",
    dateRead: item.readAt ? formatDate(item.readAt, datePattern) : "",
    dateArchived,
    updatedAt: mode === "content" ? (item.updatedAt || "") : undefined,
    yearSaved: saved.year,
    monthSaved: saved.month,
    daySaved: saved.day,
    yearPublished: published.year,
    monthPublished: published.month,
    dayPublished: published.day,
    yearRead: read.year,
    monthRead: read.month,
    dayRead: read.day,
    yearArchived: archived.year,
    monthArchived: archived.month,
    dayArchived: archived.day,
    yearUpdated: updated.year,
    monthUpdated: updated.month,
    dayUpdated: updated.day,
  };
  Object.assign(context, helperContext(onWarning, context));
  return context;
}

const PATH_SEPARATOR = /[/\\]+/g;

const slashSafe = (value: string): string => value.replace(PATH_SEPARATOR, "／");

/**
 * Article fields interpolated into a folder path may not smuggle in extra
 * levels. Template output (dates, helpers) keeps its own slashes so a user can
 * still build `yyyy/MM/dd` folders.
 */
function pathSafeItem(item: RemoteItem): RemoteItem {
  const copy: Record<string, unknown> = { ...item };
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value === "string") copy[key] = slashSafe(value);
  }
  if (Array.isArray(item.labels)) {
    copy.labels = item.labels.map((label) => ({ ...label, name: slashSafe(label.name) }));
  }
  return copy as unknown as RemoteItem;
}

export function buildPathContext(item: RemoteItem, datePattern: string, onWarning?: TemplateWarning): Record<string, any> {
  return buildContext(pathSafeItem(item), datePattern, "path", onWarning);
}
