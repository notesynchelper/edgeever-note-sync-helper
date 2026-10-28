import Mustache from "mustache";
import { USER_FACING_TEXT } from "../ui/text";

export type TemplateWarning = (message: string) => void;

export class TemplateError extends Error {
  constructor(message: string = USER_FACING_TEXT.reasons.template) {
    super(message);
    this.name = "TemplateError";
  }
}

/** Date formatting in the user's local timezone, matching the other sync plugins. */
export function formatDate(value: string | Date, pattern: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const values: Record<string, string> = {
    yyyy: String(date.getFullYear()).padStart(4, "0"),
    MM: String(date.getMonth() + 1).padStart(2, "0"),
    dd: String(date.getDate()).padStart(2, "0"),
    HH: String(date.getHours()).padStart(2, "0"),
    mm: String(date.getMinutes()).padStart(2, "0"),
    ss: String(date.getSeconds()).padStart(2, "0"),
  };
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, (token) => values[token]);
}

/** Maps a value through `needle=result` rules; `*` is the fallback and `*x*` a contains match. */
export function mapValue(rawValue: string, rawRules: string): string {
  const value = rawValue.trim();
  const wildcard: Array<{ needle: string; result: string }> = [];
  let fallback: string | undefined;
  for (const rawRule of rawRules.split(",")) {
    const rule = rawRule.trim();
    const equal = rule.indexOf("=");
    if (equal < 0) continue;
    const pattern = rule.slice(0, equal).trim();
    const result = rule.slice(equal + 1).trim();
    if (pattern === value) return result;
    if (pattern === "*") fallback = result;
    else if (pattern.length >= 2 && pattern.startsWith("*") && pattern.endsWith("*")) {
      wildcard.push({ needle: pattern.slice(1, -1), result });
    }
  }
  for (const rule of wildcard) if (rule.needle && value.includes(rule.needle)) return rule.result;
  return fallback === undefined ? value : fallback;
}

export function helperContext(
  onWarning: TemplateWarning = () => undefined,
  values: Record<string, unknown> = {},
): Record<string, () => (text: string, render: (value: string) => string) => string> {
  return {
    lowerCase: () => (text, render) => render(text).toLowerCase(),
    upperCase: () => (text, render) => render(text).toUpperCase(),
    upperCaseFirst: () => (text, render) => {
      const characters = Array.from(render(text));
      return characters.length ? characters[0].toUpperCase() + characters.slice(1).join("").toLowerCase() : "";
    },
    formatDate: () => (text, render) => {
      const comma = text.indexOf(",");
      if (comma < 0) {
        onWarning("formatDate 模板格式错误：缺少逗号分隔符");
        return "";
      }
      const expression = text.slice(0, comma).trim();
      const rendered = render(expression).trim();
      const value = rendered === expression && Object.prototype.hasOwnProperty.call(values, expression)
        ? String(values[expression] ?? "")
        : rendered;
      const pattern = render(text.slice(comma + 1)).trim();
      const output = formatDate(value, pattern);
      if (value && !output) onWarning("formatDate 收到无效日期");
      return output;
    },
    mapValue: () => (text, render) => {
      const separator = text.indexOf("|");
      if (separator < 0) return render(text).trim();
      return mapValue(render(text.slice(0, separator)), render(text.slice(separator + 1)));
    },
  };
}

/** `<% %>` comes from other note tools and is not valid here. */
export function validateMustache(template: string): void {
  if (template.includes("<%")) throw new TemplateError();
  try {
    Mustache.parse(template);
  } catch {
    throw new TemplateError();
  }
}

export function renderTemplate(template: string, context: Record<string, unknown>): string {
  validateMustache(template);
  return Mustache.render(template, context);
}
