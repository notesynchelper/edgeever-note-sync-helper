import { describe, expect, test } from "vitest";
import { cleanIndex, isMissingNoteError, isUserEdited, planSync } from "../../src/sync/dedupe";
import { advanceCursor } from "../../src/sync/cursor";

const entry = {
  noteId: "note-1",
  writtenHash: "hash-a",
  renderedHash: "render-a",
  remoteUpdatedAt: "2026-10-28T00:00:00.000Z",
};

const hashOf = (value: string) => async () => value;

describe("sync planning", () => {
  test("creates when nothing is known about the article", async () => {
    expect(await planSync({ renderedHash: "r", remoteUpdatedAt: "t" })).toBe("create");
  });

  test("skips when neither the article nor the templates changed", async () => {
    let reads = 0;
    expect(await planSync({
      entry,
      renderedHash: entry.renderedHash,
      remoteUpdatedAt: entry.remoteUpdatedAt,
      currentHash: async () => {
        reads += 1;
        return entry.writtenHash;
      },
    })).toBe("skip");
    // Skipping must not read (or hash) the note at all.
    expect(reads).toBe(0);
  });

  test("updates when the article changed underneath us", async () => {
    expect(await planSync({
      entry,
      renderedHash: entry.renderedHash,
      remoteUpdatedAt: "2026-10-29T00:00:00.000Z",
      currentHash: hashOf(entry.writtenHash),
    })).toBe("update");
  });

  test("updates when a template changed even if the article did not", async () => {
    expect(await planSync({
      entry,
      renderedHash: "render-b",
      remoteUpdatedAt: entry.remoteUpdatedAt,
      currentHash: hashOf(entry.writtenHash),
    })).toBe("update");
  });

  test("keeps the user's copy when the note no longer matches our last write", async () => {
    expect(await planSync({
      entry,
      renderedHash: "render-b",
      remoteUpdatedAt: "2026-10-29T00:00:00.000Z",
      currentHash: hashOf("user-edited"),
    })).toBe("conflict");
  });

  test("treats an entry without a recorded hash as user-edited", async () => {
    // Rebuilt from the note's marker after the local index was lost: we cannot
    // prove the note is untouched, so it must never be overwritten.
    expect(await planSync({
      entry: { ...entry, writtenHash: "" },
      renderedHash: "render-b",
      remoteUpdatedAt: "2026-10-29T00:00:00.000Z",
      currentHash: hashOf("anything"),
    })).toBe("conflict");
    expect(isUserEdited({ ...entry, writtenHash: "" }, "anything")).toBe(true);
    expect(isUserEdited(entry, entry.writtenHash)).toBe(false);
    expect(isUserEdited(entry, "user-edited")).toBe(true);
  });

  test("ignores malformed index entries", () => {
    const cleaned = cleanIndex({
      good: entry,
      missingId: { writtenHash: "x" },
      wrongType: "nope",
      array: [entry],
      "": entry,
    });
    expect(Object.keys(cleaned)).toEqual(["good"]);
    expect(cleanIndex(null)).toEqual({});
  });

  test("recognises a deleted note from the error shape", () => {
    expect(isMissingNoteError({ status: 404 })).toBe(true);
    expect(isMissingNoteError(new Error("Note not found"))).toBe(true);
    expect(isMissingNoteError({ code: "memo_not_found" })).toBe(true);
    expect(isMissingNoteError(new Error("network down"))).toBe(false);
    expect(isMissingNoteError(null)).toBe(false);
  });
});

describe("cursor", () => {
  test("takes the maximum timestamp without adding a second", () => {
    const items = [
      { updatedAt: "2026-10-27T17:44:48.067110+08:00" },
      { updatedAt: "2026-10-28T08:13:22.686076+08:00" },
      { updatedAt: "2026-10-26T22:50:33.852991+08:00" },
    ];
    expect(advanceCursor(items, "previous")).toBe("2026-10-28T00:13:22.686Z");
  });

  test("keeps the previous cursor when nothing usable came back", () => {
    expect(advanceCursor([], "previous")).toBe("previous");
    expect(advanceCursor([{ updatedAt: "not a date" }], "previous")).toBe("previous");
    expect(advanceCursor([{ updatedAt: undefined }], "")).toBe("");
  });
});
