import { describe, expect, test } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { DEFAULT_SETTINGS, SETTING_KEYS } from "../../src/settings";
import { SYNC_COMMAND_ID } from "../../src/main";

const manifestUrl = new URL("../../../manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as Record<string, any>;

/**
 * Independent transcription of the host's published manifest rules
 * (`docs/plugin-development*.md` and the `@edgeever/plugin-api` contract).
 * The host validates the same rules when a plugin is installed.
 */
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SETTING_KEY_PATTERN = /^[a-z][a-z0-9._-]*$/;
const HOST_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const ALLOWED_PERMISSIONS = new Set([
  "notes:read", "notes:write", "notes:delete", "metadata:read", "metadata:write",
  "resources:read", "resources:write", "templates:read", "templates:write",
  "network", "network:public", "ai:generate", "storage", "secrets", "schedules",
  "editor:read", "editor:write", "ui:commands", "ui:navigation", "ui:notices",
  "ui:panels", "ui:embeds",
]);

describe("plugin manifest", () => {
  test("required identity fields follow the host rules", () => {
    expect(manifest.type).toBe("plugin");
    expect(manifest.id).toBe("com.bijitongbu.note-sync-helper");
    expect(manifest.id).toMatch(ID_PATTERN);
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.trim().length).toBeGreaterThan(0);
    expect(manifest.version).toMatch(VERSION_PATTERN);
    expect(manifest.apiVersion).toBe("2");
    expect(manifest.settingsUi).toBe("host");
    expect(manifest.entry).toBe("./main.js");
    expect(manifest.platforms).toEqual(["web", "desktop"]);
  });

  test("permissions and network hosts are declarative and valid", () => {
    expect(Array.isArray(manifest.permissions)).toBe(true);
    for (const permission of manifest.permissions) {
      expect(ALLOWED_PERMISSIONS.has(permission)).toBe(true);
    }
    expect(manifest.permissions).toContain("network");
    expect(manifest.permissions).toContain("network:public");
    for (const host of manifest.networkHosts) {
      expect(host).toMatch(HOST_PATTERN);
      expect(host).not.toContain("/");
    }
    expect(new Set(manifest.networkHosts).size).toBe(manifest.networkHosts.length);
  });

  test("locales use BCP 47 tags and describe the plugin", () => {
    expect(manifest.locales["zh-CN"].description.length).toBeGreaterThan(0);
    expect(manifest.locales["en-US"].name).toBe("Note Sync Helper");
    expect(manifest.locales["en-US"].description.length).toBeGreaterThan(0);
  });

  test("setting fields are valid and match the keys the code reads", () => {
    const fields = manifest.settings.fields as Array<Record<string, any>>;
    const keys = fields.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(SETTING_KEY_PATTERN);
    expect(new Set(keys)).toEqual(new Set(Object.values(SETTING_KEYS)));

    for (const field of fields) {
      expect(typeof field.label).toBe("string");
      expect(field.label.length).toBeLessThanOrEqual(200);
      if (field.type === "secret") {
        expect(field.default).toBeUndefined();
      }
      if (field.type === "select") {
        const values = field.options.map((option: { value: string }) => option.value);
        expect(values).toContain(field.default);
      }
      if (field.type === "number") {
        expect(field.default).toBeGreaterThanOrEqual(field.min);
        expect(field.default).toBeLessThanOrEqual(field.max);
      }
      if (field.type === "boolean") {
        expect(typeof field.default).toBe("boolean");
      }
    }
  });

  test("manifest defaults match the runtime defaults", () => {
    const fields = new Map(
      (manifest.settings.fields as Array<Record<string, any>>).map((field) => [field.key, field]),
    );
    expect(fields.get(SETTING_KEYS.folderTemplate)!.default).toBe(DEFAULT_SETTINGS.folderTemplate);
    expect(fields.get(SETTING_KEYS.folderDateFormat)!.default).toBe(DEFAULT_SETTINGS.folderDateFormat);
    expect(fields.get(SETTING_KEYS.titleTemplate)!.default).toBe(DEFAULT_SETTINGS.titleTemplate);
    expect(fields.get(SETTING_KEYS.frontMatterTemplate)!.default).toBe(DEFAULT_SETTINGS.frontMatterTemplate);
    expect(fields.get(SETTING_KEYS.articleTemplate)!.default).toBe(DEFAULT_SETTINGS.articleTemplate);
    expect(fields.get(SETTING_KEYS.imageMode)!.default).toBe(DEFAULT_SETTINGS.imageMode);
    expect(fields.get(SETTING_KEYS.syncOnStart)!.default).toBe(DEFAULT_SETTINGS.syncOnStart);
    expect(fields.get(SETTING_KEYS.frequency)!.default).toBe(DEFAULT_SETTINGS.frequency);
  });

  test("the sync command id lives in the plugin namespace", () => {
    expect(SYNC_COMMAND_ID.startsWith(`${manifest.id}.`)).toBe(true);
    expect(SYNC_COMMAND_ID).toMatch(/^[a-z0-9][a-z0-9._-]*$/i);
  });

  test("built manifest, when present, is byte-identical to the repository manifest", () => {
    const distUrl = new URL("../../dist/manifest.json", import.meta.url);
    if (!existsSync(distUrl)) return;
    expect(JSON.parse(readFileSync(distUrl, "utf8"))).toEqual(manifest);
  });
});
