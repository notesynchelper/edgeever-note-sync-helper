import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", repoRoot), "utf8")) as Record<string, any>;
const textModule = readFileSync(new URL("plugin/src/ui/text.ts", repoRoot), "utf8");

/**
 * Words that only make sense to the maintainers. Anything a user reads must
 * describe the outcome, never the machinery behind it.
 */
const BANNED = [
  "openid",
  "x-api-key",
  "graphql",
  "endpoint",
  "游标",
  "cursor",
  "resource",
  "退避",
  "fallback",
  "json",
  "http",
  "api",
];

function assertClean(label: string, value: string): void {
  const haystack = value.toLowerCase();
  for (const term of BANNED) {
    if (haystack.includes(term)) {
      throw new Error(`${label} leaks the internal term "${term}": ${value}`);
    }
  }
}

function stringLiterals(source: string): string[] {
  const literals: string[] = [];
  const pattern = /(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
  for (const match of source.matchAll(pattern)) literals.push(match[2]);
  return literals;
}

describe("user-facing copy", () => {
  test("manifest copy avoids internal terms", () => {
    assertClean("plugin name", manifest.name);
    assertClean("plugin description", manifest.description);
    for (const [locale, copy] of Object.entries(manifest.locales ?? {})) {
      if (!locale.startsWith("zh")) continue;
      const metadata = copy as { name?: string; description?: string };
      if (metadata.name) assertClean(`locale ${locale} name`, metadata.name);
      if (metadata.description) assertClean(`locale ${locale} description`, metadata.description);
    }

    for (const field of manifest.settings.fields) {
      assertClean(`setting ${field.key} label`, field.label);
      if (field.description) assertClean(`setting ${field.key} description`, field.description);
      if (field.placeholder) assertClean(`setting ${field.key} placeholder`, field.placeholder);
      for (const option of field.options ?? []) {
        assertClean(`setting ${field.key} option`, option.label);
      }
    }
  });

  test("runtime notices avoid internal terms", () => {
    const literals = stringLiterals(textModule);
    expect(literals.length).toBeGreaterThan(5);
    for (const literal of literals) assertClean("ui/text.ts", literal);
  });

  test("the Chinese README section avoids internal terms", () => {
    const readmeUrl = new URL("README.md", repoRoot);
    expect(existsSync(readmeUrl)).toBe(true);
    const readme = readFileSync(readmeUrl, "utf8");
    const marker = readme.indexOf("## 中文说明");
    expect(marker).toBeGreaterThan(0);
    assertClean("README 中文说明", readme.slice(marker));
  });

  test("the manifest stays free of host-specific build notes", () => {
    const text = JSON.stringify(manifest);
    expect(text).not.toMatch(/\/data\/|\/home\/|127\.0\.0\.1|localhost/);
  });
});
