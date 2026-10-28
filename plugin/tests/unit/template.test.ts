import { describe, expect, test } from "vitest";
import { makeItem } from "../helpers/fixtures";
import { buildContext, buildPathContext } from "../../src/template/context";
import { formatDate, mapValue, TemplateError } from "../../src/template/helpers";
import { renderContent, renderPath, safeNoteTitle, cleanNotebookSegment, MAX_NOTE_TITLE_LENGTH } from "../../src/template/render";
import { splitNotebookPath } from "../../src/sync/notebooks";
import {
  SOURCE_ID_FIELD,
  buildFrontMatter,
  composeMarkdown,
  escapeYamlString,
  extractSourceId,
  extractTags,
} from "../../src/template/frontMatter";
import { DEFAULT_FRONT_MATTER_TEMPLATE, DEFAULT_SETTINGS } from "../../src/settings";

const noonUtc = (overrides = {}) => makeItem({
  savedAt: "2026-10-28T12:00:00.000Z",
  updatedAt: "2026-10-28T12:00:00.000Z",
  publishedAt: "2026-10-20T12:00:00.000Z",
  ...overrides,
});

describe("template rendering", () => {
  test("substitutes article fields and keeps braces inside content untouched", () => {
    const item = noonUtc({ content: "代码里的 {{{not_a_var}}} 不会被替换。" });
    expect(renderContent(item, "{{{title}}}", "yyyy-MM-dd")).toBe(item.title);
    expect(renderContent(item, "{{{content}}}", "yyyy-MM-dd")).toContain("{{{not_a_var}}}");
    expect(renderContent(item, "{{author}} / {{siteName}}", "yyyy-MM-dd")).toBe("笔记同步助手 / 微信公众号");
  });

  test("iterates labels and falls back for missing values", () => {
    const item = noonUtc({ labels: [{ name: "效率工具" }, { name: "笔记" }] });
    expect(renderContent(item, "[{{#labels}}{{{name}}},{{/labels}}]", "yyyy-MM-dd")).toBe("[效率工具,笔记,]");
    expect(renderContent(item, "{{{missing}}}", "yyyy-MM-dd")).toBe("");
  });

  test("supports the helper sections used by existing templates", () => {
    const item = noonUtc({ title: "Mixed CASE Title" });
    expect(renderContent(item, "{{#lowerCase}}{{{title}}}{{/lowerCase}}", "yyyy-MM-dd")).toBe("mixed case title");
    expect(renderContent(item, "{{#upperCase}}{{{title}}}{{/upperCase}}", "yyyy-MM-dd")).toBe("MIXED CASE TITLE");
    expect(renderContent(item, "{{#upperCaseFirst}}{{{title}}}{{/upperCaseFirst}}", "yyyy-MM-dd")).toBe("Mixed case title");
    expect(renderContent(item, "{{#mapValue}}{{state}}|INBOX=收件箱,*=其他{{/mapValue}}", "yyyy-MM-dd")).toBe("收件箱");
  });

  test("date variables follow the configured folder pattern", () => {
    const item = noonUtc();
    // Local time by design: a folder named after the day the user saved it.
    const saved = new Date(item.savedAt);
    const year = String(saved.getFullYear()).padStart(4, "0");
    const month = String(saved.getMonth() + 1).padStart(2, "0");
    const day = String(saved.getDate()).padStart(2, "0");
    expect(renderContent(item, "{{{date}}}", "yyyy-MM-dd")).toBe(`${year}-${month}-${day}`);
    expect(renderContent(item, "{{{date}}}", "yyyy/MM/dd")).toBe(`${year}/${month}/${day}`);
    expect(renderPath(item, "{{{yearSaved}}}-{{{monthSaved}}}-{{{daySaved}}}", "yyyy-MM-dd")).toBe(`${year}-${month}-${day}`);
  });

  test("formatDate helper handles a trailing pattern and warns on invalid dates", () => {
    const warnings: string[] = [];
    const item = noonUtc();
    const saved = new Date(item.savedAt);
    const expected = `${saved.getFullYear()}${String(saved.getMonth() + 1).padStart(2, "0")}${String(saved.getDate()).padStart(2, "0")}`;
    expect(renderContent(item, "{{#formatDate}}savedAt, yyyyMMdd{{/formatDate}}", "yyyy-MM-dd", (w) => warnings.push(w))).toBe(expected);
    expect(renderContent(item, "{{#formatDate}}nope, yyyy-MM-dd{{/formatDate}}", "yyyy-MM-dd", (w) => warnings.push(w))).toBe("");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("formatDate/mapValue behave outside templates", () => {
    expect(formatDate("2026-10-28T12:34:56Z", "yyyy-MM-dd HH:mm:ss")).toMatch(/^2026-10-28 \d{2}:\d{2}:\d{2}$/);
    expect(formatDate("not a date", "yyyy")).toBe("");
    expect(mapValue("VIDEO", "ARTICLE=文章,VIDEO=视频,*=其他")).toBe("视频");
    expect(mapValue("OTHER", "ARTICLE=文章,*=其他")).toBe("其他");
    expect(mapValue("OTHER", "ARTICLE=文章")).toBe("OTHER");
    expect(mapValue("x", "*mid*=匹配")).toBe("x");
  });

  test("path context replaces slashes coming from article fields", () => {
    const item = noonUtc({
      title: "a/b\\c",
      author: "x/y",
      slug: "slug/with\\slashes",
      description: "d/e",
      content: "正文/含反斜杠\\",
      labels: [{ name: "标签/一" }, { name: "标签\\二" }],
    });
    const context = buildPathContext(item, "yyyy-MM-dd");
    expect(context.title).toBe("a／b／c");
    expect(context.author).toBe("x／y");
    expect(context.slug).toBe("slug／with／slashes");
    expect(context.description).toBe("d／e");
    expect(context.content).toBe("正文／含反斜杠／");
    expect(context.labels.map((label: { name: string }) => label.name)).toEqual(["标签／一", "标签／二"]);
    // Content templates keep the article exactly as it was.
    expect(buildContext(item, "yyyy-MM-dd", "content").title).toBe("a/b\\c");
  });

  test("a date pattern with slashes still builds notebook levels", () => {
    const item = noonUtc();
    const rendered = renderPath(item, "笔记同步助手/{{{date}}}", "yyyy/MM/dd");
    const date = new Date(item.savedAt);
    const year = String(date.getFullYear()).padStart(4, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    expect(splitNotebookPath(rendered)).toEqual(["笔记同步助手", year, month, day]);
  });

  test("template syntax errors surface as TemplateError", () => {
    expect(() => renderContent(noonUtc(), "<% tp.date.now() %>", "yyyy-MM-dd")).toThrow(TemplateError);
    expect(() => renderContent(noonUtc(), "{{#open}}", "yyyy-MM-dd")).toThrow(TemplateError);
  });

  test("note titles are cleaned, capped and never empty", () => {
    expect(safeNoteTitle("  标题 / 副标题  ", "abcdefgh")).toBe("标题 副标题");
    const long = safeNoteTitle("字".repeat(400), "abcdefgh");
    expect(Array.from(long).length).toBe(MAX_NOTE_TITLE_LENGTH);
    expect(safeNoteTitle("   ", "abcdefgh-1234")).toBe("无标题-abcdefgh");
    expect(cleanNotebookSegment("  a\\b  ")).toBe("a／b");
  });
});

describe("properties block", () => {
  test("always appends the source marker, even with an empty template", () => {
    const item = noonUtc();
    const withTemplate = buildFrontMatter(item, DEFAULT_SETTINGS.frontMatterTemplate, "yyyy-MM-dd");
    expect(withTemplate.yaml).toContain(`${SOURCE_ID_FIELD}: "${item.id}"`);
    expect(withTemplate.yaml.startsWith("author: 笔记同步助手")).toBe(true);
    expect(withTemplate.tags).toEqual(["笔记同步助手", "效率工具"]);

    const empty = buildFrontMatter(item, "", "yyyy-MM-dd");
    expect(empty.yaml).toBe(`${SOURCE_ID_FIELD}: "${item.id}"`);
    expect(empty.tags).toEqual([]);
  });

  test("an anchor produced by the template is replaced, not duplicated", () => {
    const item = noonUtc();
    const rendered = buildFrontMatter(item, `notehelper-id: "stale"\nauthor: {{{author}}}`, "yyyy-MM-dd");
    expect(rendered.yaml.match(new RegExp(SOURCE_ID_FIELD, "g"))).toHaveLength(1);
    expect(rendered.yaml).toContain(`"${item.id}"`);
    expect(rendered.yaml).not.toContain("stale");
  });

  test("composes front matter and body in the shape the host expects", () => {
    expect(composeMarkdown("a: 1", "正文\n\n")).toBe("---\na: 1\n---\n\n正文");
    expect(composeMarkdown("a: 1", "  ")).toBe("---\na: 1\n---\n");
  });

  test("reads the marker back out of a note", () => {
    const item = noonUtc();
    const markdown = composeMarkdown(buildFrontMatter(item, DEFAULT_FRONT_MATTER_TEMPLATE, "yyyy-MM-dd").yaml, "body");
    expect(extractSourceId(markdown)).toBe(item.id);
    expect(extractSourceId(`---\nnotehelper-id: abc\n---\n\nx`)).toBe("abc");
    expect(extractSourceId(`---\nnotehelper-id: 'q"uote'\n---\n`)).toBe('q"uote');
    expect(extractSourceId("no front matter")).toBeNull();
    expect(extractSourceId("---\na: 1\n---\n")).toBeNull();
  });

  test("escapes ids that would break the YAML string", () => {
    expect(escapeYamlString('a"b\\c\nd')).toBe('a\\"b\\\\c d');
  });

  test("extractTags tolerates a comma separated value and malformed YAML", () => {
    expect(extractTags("tags: 笔记, 效率")).toEqual(["笔记", "效率"]);
    expect(extractTags("tags: [a, b]\n")).toEqual(["a", "b"]);
    expect(extractTags("tags: [unclosed")).toEqual([]);
  });
});
