import { describe, expect, test } from "vitest";
import { fnv1a64 } from "../../src/util/hash";

/**
 * Expected values were produced by the previous BigInt implementation. The
 * fallback only needs to stay stable: existing `writtenHash` values in user
 * storage must keep matching after this implementation change.
 */
const FIXTURES: Array<[string, string]> = [
  ["", "cbf29ce484222325"],
  ["a", "af63dc4c8601ec8c"],
  ["hello", "a430d84680aabd0b"],
  ["笔记同步助手", "7f2f6329a0bafdd9"],
  ["The quick brown fox jumps over the lazy dog", "f3f9b7f5e7e47110"],
  ["lorem ipsum dolor sit amet 12345", "bab7f8b825fa7482"],
];

describe("fnv1a64 fallback", () => {
  test("matches the previous implementation bit for bit", () => {
    for (const [input, expected] of FIXTURES) {
      expect(fnv1a64(input)).toBe(expected);
    }
  });

  test("always prints 16 lowercase hex characters", () => {
    for (const [input] of FIXTURES) {
      expect(fnv1a64(input)).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
