import type { PluginContext } from "./edgeever";

/** Setting keys declared in `manifest.json` (host-rendered settings). */
export const SETTING_KEYS = {
  apiKey: "api-key",
  folderTemplate: "folder-template",
  folderDateFormat: "folder-date-format",
  titleTemplate: "title-template",
  frontMatterTemplate: "front-matter-template",
  articleTemplate: "article-template",
  imageMode: "image-mode",
  syncOnStart: "sync-on-start",
  frequency: "frequency",
} as const;

export type ImageMode = "local" | "remote";

/**
 * The host renders every text setting as a single-line input, which drops
 * newlines, so the properties template is stored one property per `; `.
 * `frontMatterLines` turns it back into YAML lines; multi-line values written
 * by older builds still work unchanged.
 */
export const DEFAULT_FRONT_MATTER_TEMPLATE = [
  "author: {{{author}}}",
  "source: {{{siteName}}}",
  "url: {{{originalUrl}}}",
  "saved: {{{dateSaved}}}",
  "tags: [笔记同步助手{{#labels}}, {{{name}}}{{/labels}}]",
].join("; ");

/**
 * Splits a properties template on newlines and on `; ` that starts a new
 * `key:` entry, so a `;` inside a value (or inside a tag list) is kept.
 */
export function frontMatterLines(template: string): string {
  return template
    .split(/\r?\n/)
    .flatMap((line) => line.split(/;\s*(?=[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff-]*\s*:)/))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

const DEFAULT_FOLDER_TEMPLATE = "笔记同步助手/{{{date}}}";
const DEFAULT_FOLDER_DATE_FORMAT = "yyyy-MM-dd";
const DEFAULT_TITLE_TEMPLATE = "{{{title}}}";
const DEFAULT_ARTICLE_TEMPLATE = "{{{content}}}";

const MIN_FREQUENCY_MINUTES = 0;
const MAX_FREQUENCY_MINUTES = 10_080;

export interface PluginSettings {
  apiKey: string;
  folderTemplate: string;
  folderDateFormat: string;
  titleTemplate: string;
  frontMatterTemplate: string;
  articleTemplate: string;
  imageMode: ImageMode;
  syncOnStart: boolean;
  frequency: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  apiKey: "",
  folderTemplate: DEFAULT_FOLDER_TEMPLATE,
  folderDateFormat: DEFAULT_FOLDER_DATE_FORMAT,
  titleTemplate: DEFAULT_TITLE_TEMPLATE,
  frontMatterTemplate: DEFAULT_FRONT_MATTER_TEMPLATE,
  articleTemplate: DEFAULT_ARTICLE_TEMPLATE,
  imageMode: "local",
  syncOnStart: false,
  frequency: 0,
};

const asString = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

export const clampFrequency = (value: unknown): number => {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(MAX_FREQUENCY_MINUTES, Math.max(MIN_FREQUENCY_MINUTES, parsed));
};

/** Coerces whatever the host hands back into a complete, usable settings object. */
export function normalizeSettings(raw: Record<string, unknown>): PluginSettings {
  const imageMode = raw[SETTING_KEYS.imageMode] === "remote" ? "remote" : "local";
  return {
    apiKey: asString(raw[SETTING_KEYS.apiKey], "").trim(),
    folderTemplate: asString(raw[SETTING_KEYS.folderTemplate], DEFAULT_FOLDER_TEMPLATE),
    folderDateFormat: asString(raw[SETTING_KEYS.folderDateFormat], DEFAULT_FOLDER_DATE_FORMAT),
    titleTemplate: asString(raw[SETTING_KEYS.titleTemplate], DEFAULT_TITLE_TEMPLATE),
    frontMatterTemplate: asString(raw[SETTING_KEYS.frontMatterTemplate], DEFAULT_FRONT_MATTER_TEMPLATE),
    articleTemplate: asString(raw[SETTING_KEYS.articleTemplate], DEFAULT_ARTICLE_TEMPLATE),
    imageMode,
    syncOnStart: asBoolean(raw[SETTING_KEYS.syncOnStart], false),
    frequency: clampFrequency(raw[SETTING_KEYS.frequency]),
  };
}

export async function readSettings(context: PluginContext): Promise<PluginSettings> {
  const keys = Object.values(SETTING_KEYS);
  const values = await Promise.all(keys.map((key) => context.settings.get(key)));
  const raw: Record<string, unknown> = {};
  keys.forEach((key, index) => {
    raw[key] = values[index];
  });
  return normalizeSettings(raw);
}
