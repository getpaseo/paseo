import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  buildTranscriptFindIndex,
  firstMatchAtOrAfter,
  locate,
  resolveMatch,
  searchableText,
  type TranscriptFindItem,
} from "./index";

const TIMESTAMP = new Date("2026-01-01T00:00:00.000Z");

function userMessage(id: string, text: string): StreamItem {
  return { kind: "user_message", id, text, timestamp: TIMESTAMP };
}

function assistantMessage(id: string, text: string): StreamItem {
  return { kind: "assistant_message", id, text, timestamp: TIMESTAMP };
}

function loaded(...items: StreamItem[]): TranscriptFindItem[] {
  return items.map((item) => ({ item, isStreaming: false }));
}

describe("searchableText", () => {
  it("takes a user message verbatim, because it renders as one plain Text", () => {
    expect(searchableText(userMessage("u1", "**not** markdown"))).toBe("**not** markdown");
  });

  it("projects an assistant message through its markdown rendering", () => {
    expect(searchableText(assistantMessage("a1", "**bold** word"))).toBe("bold word");
  });

  it("indexes nothing for kinds find does not mark", () => {
    const thought: StreamItem = {
      kind: "thought",
      id: "t1",
      text: "thinking about needles",
      status: "ready",
      timestamp: TIMESTAMP,
    };
    expect(searchableText(thought)).toBe("");
  });
});

describe("buildTranscriptFindIndex", () => {
  it("counts case-insensitively and keeps items in render order", () => {
    const index = buildTranscriptFindIndex(
      loaded(userMessage("u1", "Needle needle"), assistantMessage("a1", "no match")),
      "NEEDLE",
    );

    expect(index.total).toBe(2);
    expect(index.entries).toEqual([
      { itemId: "u1", count: 2, offset: 0 },
      { itemId: "a1", count: 0, offset: 2 },
    ]);
  });

  it("counts non-overlapping occurrences, the way the DOM walk does", () => {
    const index = buildTranscriptFindIndex(loaded(userMessage("u1", "aaaa")), "aa");
    expect(index.total).toBe(2);
  });

  // The DOM walk folds Turkish dotted capital I (\u0130) to "i" plus a combining dot;
  // the index has to agree, or the counter and the marks disagree on a row.
  it("counts a fold that changes length the way the DOM walk does", () => {
    const items = loaded(userMessage("u1", "\u0130stanbul and \u0130STANBUL"));

    expect(buildTranscriptFindIndex(items, "i\u0307stanbul").total).toBe(2);
    expect(buildTranscriptFindIndex(items, "istanbul").total).toBe(0);
  });

  it("counts nothing for an empty query", () => {
    const index = buildTranscriptFindIndex(loaded(userMessage("u1", "needle")), "");
    expect(index.total).toBe(0);
  });

  it("skips an item whose paced reveal is still painting it", () => {
    const items: TranscriptFindItem[] = [
      { item: userMessage("u1", "needle"), isStreaming: false },
      { item: assistantMessage("a1", "needle"), isStreaming: true },
    ];

    const index = buildTranscriptFindIndex(items, "needle");

    expect(index.total).toBe(1);
    expect(index.entries[1]).toEqual({ itemId: "a1", count: 0, offset: 1 });
  });
});

describe("resolveMatch", () => {
  const index = buildTranscriptFindIndex(
    loaded(
      userMessage("u1", "needle needle"),
      assistantMessage("a1", "nothing"),
      userMessage("u2", "needle"),
    ),
    "needle",
  );

  it("maps a global index onto the row and the occurrence inside it", () => {
    expect(resolveMatch(index, 0)).toEqual({ itemId: "u1", occurrence: 0 });
    expect(resolveMatch(index, 1)).toEqual({ itemId: "u1", occurrence: 1 });
    expect(resolveMatch(index, 2)).toEqual({ itemId: "u2", occurrence: 0 });
  });

  it("has nothing outside the match range", () => {
    expect(resolveMatch(index, -1)).toBeNull();
    expect(resolveMatch(index, 3)).toBeNull();
  });

  it("round-trips through locate", () => {
    expect(locate(index, "u2", 0)).toBe(2);
    expect(locate(index, "a1", 0)).toBeNull();
    expect(locate(index, "gone", 0)).toBeNull();
  });
});

describe("firstMatchAtOrAfter", () => {
  const index = buildTranscriptFindIndex(
    loaded(
      userMessage("u1", "needle"),
      assistantMessage("a1", "nothing"),
      userMessage("u2", "needle needle"),
      assistantMessage("a2", "nothing"),
    ),
    "needle",
  );

  it("starts at the row the reader is looking at", () => {
    expect(firstMatchAtOrAfter(index, "u1")).toBe(0);
    expect(firstMatchAtOrAfter(index, "u2")).toBe(1);
  });

  it("skips ahead when the row itself has no match", () => {
    expect(firstMatchAtOrAfter(index, "a1")).toBe(1);
  });

  it("reports nothing below, so the caller can wrap", () => {
    expect(firstMatchAtOrAfter(index, "a2")).toBeNull();
  });

  it("reports nothing for a row that is not loaded", () => {
    expect(firstMatchAtOrAfter(index, "gone")).toBeNull();
  });
});
