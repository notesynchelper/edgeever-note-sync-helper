import { describe, expect, test } from "vitest";
import {
  DEFAULT_FRONT_MATTER_TEMPLATE,
  DEFAULT_SETTINGS,
  normalizeSettings,
  SETTING_KEYS,
  clampFrequency,
  frontMatterLines,
} from "../../src/settings";
import { createFakeHost } from "../helpers/fakeHost";
import { readSettings } from "../../src/settings";

describe("settings", () => {
  test("empty input falls back to the documented defaults", () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.imageMode).toBe("local");
    expect(DEFAULT_SETTINGS.frontMatterTemplate).toBe(DEFAULT_FRONT_MATTER_TEMPLATE);
    expect(DEFAULT_SETTINGS.folderTemplate).toBe("笔记同步助手/{{{date}}}");
  });

  test("reads values from the host and trims the key", async () => {
    const { context } = createFakeHost({
      settings: {
        [SETTING_KEYS.apiKey]: "  abc  ",
        [SETTING_KEYS.imageMode]: "remote",
        [SETTING_KEYS.frequency]: 30,
        [SETTING_KEYS.syncOnStart]: true,
      },
    });
    const settings = await readSettings(context);
    expect(settings.apiKey).toBe("abc");
    expect(settings.imageMode).toBe("remote");
    expect(settings.frequency).toBe(30);
    expect(settings.syncOnStart).toBe(true);
  });

  test("rejects unknown image modes and clamps the frequency", () => {
    expect(normalizeSettings({ [SETTING_KEYS.imageMode]: "disabled" }).imageMode).toBe("local");
    expect(normalizeSettings({ [SETTING_KEYS.imageMode]: "remote" }).imageMode).toBe("remote");
    expect(clampFrequency(-10)).toBe(0);
    expect(clampFrequency(1e9)).toBe(10080);
    expect(clampFrequency(3.6)).toBe(4);
    expect(clampFrequency("nope")).toBe(0);
    expect(normalizeSettings({ [SETTING_KEYS.syncOnStart]: "yes" }).syncOnStart).toBe(false);
  });
});

describe("frontMatterLines", () => {
  test("splits a single-line template into one property per line", () => {
    expect(frontMatterLines(DEFAULT_FRONT_MATTER_TEMPLATE)).toBe([
      "author: {{{author}}}",
      "source: {{{siteName}}}",
      "url: {{{originalUrl}}}",
      "saved: {{{dateSaved}}}",
      "tags: [笔记同步助手{{#labels}}, {{{name}}}{{/labels}}]",
    ].join("\n"));
  });

  test("keeps a semicolon that is part of a value", () => {
    expect(frontMatterLines("note: a; b; 来源: x")).toBe("note: a; b\n来源: x");
  });

  test("leaves multi-line templates from older builds unchanged", () => {
    expect(frontMatterLines("author: {{{author}}}\nurl: {{{originalUrl}}}")).toBe("author: {{{author}}}\nurl: {{{originalUrl}}}");
  });
});
