import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { resolveTurnAttribution } from "./turn-attribution";

function assistant(
  id: string,
  attribution?: { model?: string; thinkingOptionId?: string },
): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text: `text ${id}`,
    timestamp: new Date("2026-07-30T00:00:00.000Z"),
    ...attribution,
  };
}

function user(id: string): StreamItem {
  return {
    kind: "user_message",
    id,
    text: "prompt",
    timestamp: new Date("2026-07-30T00:00:00.000Z"),
  };
}

// Traversal runs from a turn's last item toward its first, so a step of -1 walks
// a display-ordered list and +1 walks an inverted (newest-first) one.
const DISPLAY_ORDER = -1;
const INVERTED_ORDER = 1;

describe("resolveTurnAttribution", () => {
  it("reads the model and thinking level recorded on the turn", () => {
    const items = [user("u1"), assistant("a1", { model: "gpt-5.6-sol", thinkingOptionId: "high" })];

    expect(resolveTurnAttribution(items, 1, DISPLAY_ORDER)).toEqual({
      model: "gpt-5.6-sol",
      thinkingOptionId: "high",
    });
  });

  it("returns null when the turn recorded nothing, so history stays unlabeled", () => {
    expect(resolveTurnAttribution([user("u1"), assistant("a1")], 1, DISPLAY_ORDER)).toBeNull();
  });

  it("keeps a model with no thinking level, for providers that report only one", () => {
    expect(
      resolveTurnAttribution([assistant("a1", { model: "claude-opus-4-5" })], 0, DISPLAY_ORDER),
    ).toEqual({ model: "claude-opus-4-5" });
  });

  it("prefers the value the turn ended on when the model changed mid-turn", () => {
    const items = [
      assistant("a1", { model: "gpt-5.6-luna", thinkingOptionId: "low" }),
      assistant("a2", { model: "gpt-5.6-sol", thinkingOptionId: "high" }),
    ];

    expect(resolveTurnAttribution(items, 1, DISPLAY_ORDER)).toEqual({
      model: "gpt-5.6-sol",
      thinkingOptionId: "high",
    });
  });

  it("stops at the user message that opened the turn", () => {
    const items = [
      assistant("a0", { model: "previous-turn-model" }),
      user("u1"),
      assistant("a1", { model: "this-turn-model" }),
    ];

    expect(resolveTurnAttribution(items, 2, DISPLAY_ORDER)).toEqual({ model: "this-turn-model" });
  });

  it("does not borrow attribution from a later turn", () => {
    // The regression: a turn that ran on Fable rendered the next turn's Sonnet
    // because the walk ran to the end of the stream instead of stopping.
    const items = [
      assistant("a1", { model: "claude-fable-5", thinkingOptionId: "high" }),
      user("u2"),
      assistant("a2", { model: "claude-sonnet-5", thinkingOptionId: "low" }),
    ];

    expect(resolveTurnAttribution(items, 0, DISPLAY_ORDER)).toEqual({
      model: "claude-fable-5",
      thinkingOptionId: "high",
    });
  });

  it("returns null for an unattributed turn rather than a neighbour's attribution", () => {
    const items = [
      assistant("a1"),
      user("u2"),
      assistant("a2", { model: "claude-sonnet-5", thinkingOptionId: "low" }),
    ];

    expect(resolveTurnAttribution(items, 0, DISPLAY_ORDER)).toBeNull();
  });

  it("walks the other way for an inverted list", () => {
    // Newest first, as an inverted FlatList holds it.
    const items = [
      assistant("a2", { model: "claude-sonnet-5", thinkingOptionId: "low" }),
      user("u2"),
      assistant("a1", { model: "claude-fable-5", thinkingOptionId: "high" }),
    ];

    expect(resolveTurnAttribution(items, 2, INVERTED_ORDER)).toEqual({
      model: "claude-fable-5",
      thinkingOptionId: "high",
    });
    expect(resolveTurnAttribution(items, 0, INVERTED_ORDER)).toEqual({
      model: "claude-sonnet-5",
      thinkingOptionId: "low",
    });
  });

  it("skips unattributed trailing messages rather than clearing the turn's model", () => {
    const items = [assistant("a1", { model: "gpt-5.6-sol" }), assistant("a2")];

    expect(resolveTurnAttribution(items, 1, DISPLAY_ORDER)).toEqual({ model: "gpt-5.6-sol" });
  });
});
