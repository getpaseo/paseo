import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  collectEstimatedPinnedUserInputCandidates,
  findEstimatedStreamItemTop,
  selectPinnedUserInput,
  type PinnedUserInputCandidate,
} from "./pinned-user-input";

function userMessage(id: string): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function assistantMessage(id: string): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function candidate(id: string, top: number, bottom: number): PinnedUserInputCandidate {
  return {
    item: userMessage(id),
    top,
    bottom,
  };
}

describe("selectPinnedUserInput", () => {
  it("returns null when disabled", () => {
    expect(
      selectPinnedUserInput({
        enabled: false,
        candidates: [candidate("u1", 0, 80)],
        viewportTop: 120,
        viewportBottom: 520,
      }),
    ).toBeNull();
  });

  it("selects the latest user input at or above the viewport midpoint", () => {
    expect(
      selectPinnedUserInput({
        enabled: true,
        candidates: [candidate("u1", 0, 80), candidate("u2", 500, 580)],
        viewportTop: 620,
        viewportBottom: 1000,
      })?.item.id,
    ).toBe("u2");
  });

  it("hides the relevant user input while it is visible in the viewport", () => {
    expect(
      selectPinnedUserInput({
        enabled: true,
        candidates: [candidate("u1", 0, 80), candidate("u2", 500, 580)],
        viewportTop: 520,
        viewportBottom: 920,
      }),
    ).toBeNull();
  });

  it("keeps the previous user input until the next input top crosses the viewport midpoint", () => {
    expect(
      selectPinnedUserInput({
        enabled: true,
        candidates: [candidate("u1", 0, 80), candidate("u2", 700, 780)],
        viewportTop: 300,
        viewportBottom: 900,
      })?.item.id,
    ).toBe("u1");
  });

  it("hides the previous pinned input when the next input top crosses the viewport midpoint", () => {
    expect(
      selectPinnedUserInput({
        enabled: true,
        candidates: [candidate("u1", 0, 80), candidate("u2", 700, 780)],
        viewportTop: 500,
        viewportBottom: 1000,
      }),
    ).toBeNull();
  });

  it("switches to the next user input after it scrolls off the top", () => {
    expect(
      selectPinnedUserInput({
        enabled: true,
        candidates: [candidate("u1", 0, 80), candidate("u2", 700, 780)],
        viewportTop: 800,
        viewportBottom: 1100,
      })?.item.id,
    ).toBe("u2");
  });

  it("returns null when no user inputs are above the viewport midpoint", () => {
    expect(
      selectPinnedUserInput({
        enabled: true,
        candidates: [candidate("u1", 500, 580)],
        viewportTop: 0,
        viewportBottom: 300,
      }),
    ).toBeNull();
  });
});

describe("collectEstimatedPinnedUserInputCandidates", () => {
  it("keeps estimated coordinates in stream order", () => {
    const items: StreamItem[] = [userMessage("u1"), assistantMessage("a1"), userMessage("u2")];
    const heightById = new Map<string, number>([
      ["u1", 80],
      ["a1", 320],
      ["u2", 90],
    ]);

    expect(
      collectEstimatedPinnedUserInputCandidates({
        items,
        estimateHeight: (item) => heightById.get(item.id) ?? 0,
      }),
    ).toEqual([
      { item: expect.objectContaining({ id: "u1" }), top: 0, bottom: 80 },
      { item: expect.objectContaining({ id: "u2" }), top: 400, bottom: 490 },
    ]);
  });
});

describe("findEstimatedStreamItemTop", () => {
  it("returns the estimated top in stream order", () => {
    const items: StreamItem[] = [userMessage("u1"), assistantMessage("a1"), userMessage("u2")];
    const heightById = new Map<string, number>([
      ["u1", 80],
      ["a1", 320],
      ["u2", 90],
    ]);

    expect(
      findEstimatedStreamItemTop({
        items,
        itemId: "u2",
        estimateHeight: (item) => heightById.get(item.id) ?? 0,
      }),
    ).toBe(400);
  });
});
