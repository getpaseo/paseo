import { describe, expect, it } from "vitest";
import {
  appendTextTokenToComposer,
  buildComposerInsertResult,
  insertTextAtSelection,
} from "./composer-text-insert";

describe("insertTextAtSelection", () => {
  it("replaces the selected text and collapses the caret after the inserted token", () => {
    const result = insertTextAtSelection({
      value: "review old text now",
      insertedText: "src/example.ts:12-18",
      selection: { start: 7, end: 15 },
    });

    expect(result).toEqual({
      text: "review src/example.ts:12-18 now",
      selection: { start: 27, end: 27 },
    });
  });

  it("inserts at a collapsed caret", () => {
    const result = insertTextAtSelection({
      value: "review this",
      insertedText: "src/example.ts:9",
      selection: { start: 7, end: 7 },
    });

    expect(result).toEqual({
      text: "review src/example.ts:9 this",
      selection: { start: 24, end: 24 },
    });
  });

  it("adds a trailing space when inserting at the end", () => {
    const result = insertTextAtSelection({
      value: "review",
      insertedText: "src/example.ts:9",
      selection: { start: 6, end: 6 },
    });

    expect(result).toEqual({
      text: "reviewsrc/example.ts:9 ",
      selection: { start: 23, end: 23 },
    });
  });
});

describe("appendTextTokenToComposer", () => {
  it("appends a token with minimal whitespace normalization", () => {
    expect(
      appendTextTokenToComposer({
        value: "review",
        token: "src/example.ts:12-18",
      }),
    ).toBe("review src/example.ts:12-18 ");
  });

  it("does not add extra blank lines when the composer already ends with a newline", () => {
    expect(
      appendTextTokenToComposer({
        value: "review this\n",
        token: "src/example.ts",
      }),
    ).toBe("review this\nsrc/example.ts ");
  });
});

describe("buildComposerInsertResult", () => {
  it("uses the stored selection when one is known", () => {
    const result = buildComposerInsertResult({
      value: "review old text now",
      token: "src/example.ts:12-18",
      selection: { start: 7, end: 15 },
      hasKnownSelection: true,
    });

    expect(result).toEqual({
      text: "review src/example.ts:12-18 now",
      selection: { start: 27, end: 27 },
    });
  });

  it("falls back to append when no prior selection is known", () => {
    const result = buildComposerInsertResult({
      value: "review this",
      token: "src/example.ts",
      selection: { start: 0, end: 0 },
      hasKnownSelection: false,
    });

    expect(result).toEqual({
      text: "review this src/example.ts ",
      selection: { start: 27, end: 27 },
    });
  });
});
