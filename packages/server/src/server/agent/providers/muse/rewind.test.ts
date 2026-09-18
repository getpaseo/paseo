import { describe, expect, test } from "vitest";

import type { MuseViewItem } from "./items.js";
import { resolveMuseRewindCutPoint } from "./rewind.js";

function item(itemId: string, turnId?: string): MuseViewItem {
  return {
    itemId,
    revision: 1,
    kind: "userMessage",
    ...(turnId ? { turnId } : {}),
  };
}

const HISTORY = [
  item("u1", "turn-1"),
  item("a1", "turn-1"),
  item("u2", "turn-2"),
  item("a2", "turn-2"),
];

describe("resolveMuseRewindCutPoint", () => {
  test("forks through the last turn before the target", () => {
    expect(resolveMuseRewindCutPoint(HISTORY, "u2")).toEqual({
      kind: "fork",
      lastTurnId: "turn-1",
    });
    expect(resolveMuseRewindCutPoint(HISTORY, "a2")).toEqual({
      kind: "fork",
      lastTurnId: "turn-1",
    });
  });

  test("plans a fresh session for targets in the first turn", () => {
    expect(resolveMuseRewindCutPoint(HISTORY, "u1")).toEqual({ kind: "fresh" });
    expect(resolveMuseRewindCutPoint([item("u1", "turn-1")], "u1")).toEqual({ kind: "fresh" });
  });

  test("rejects blank, unknown, and turn-less targets", () => {
    expect(() => resolveMuseRewindCutPoint(HISTORY, "  ")).toThrow(
      "Muse rewind requires a message id",
    );
    expect(() => resolveMuseRewindCutPoint(HISTORY, "missing")).toThrow(
      "Muse rewind target missing was not found in history",
    );
    expect(() => resolveMuseRewindCutPoint([item("lonely")], "lonely")).toThrow(
      "Muse rewind target lonely is not part of a turn",
    );
  });
});
