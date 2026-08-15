import { describe, expect, it } from "vitest";

import type { StreamItem } from "@/types/stream";
import {
  DRAFT_HISTORY_INDEX,
  collectUserMessageHistory,
  shouldEnterMessageHistory,
  stepMessageHistory,
} from "./message-history";

function userMessage(id: string, text: string): StreamItem {
  return { kind: "user_message", id, text, timestamp: new Date(0) };
}

function assistantMessage(id: string, text: string): StreamItem {
  return { kind: "assistant_message", id, text, timestamp: new Date(0) };
}

describe("collectUserMessageHistory", () => {
  it("returns the user's own messages newest first", () => {
    const history = collectUserMessageHistory([
      userMessage("1", "first"),
      assistantMessage("2", "a reply"),
      userMessage("3", "second"),
      assistantMessage("4", "another reply"),
      userMessage("5", "third"),
    ]);
    expect(history).toEqual(["third", "second", "first"]);
  });

  it("skips assistant output, blank messages, and adjacent repeats", () => {
    const history = collectUserMessageHistory([
      userMessage("1", "keep"),
      userMessage("2", "   "),
      userMessage("3", "repeat"),
      userMessage("4", "repeat"),
      assistantMessage("5", "noise"),
    ]);
    expect(history).toEqual(["repeat", "keep"]);
  });

  it("is empty for a conversation the user has not spoken in", () => {
    expect(collectUserMessageHistory([assistantMessage("1", "hello")])).toEqual([]);
    expect(collectUserMessageHistory([])).toEqual([]);
  });
});

describe("stepMessageHistory", () => {
  const history = ["newest", "middle", "oldest"];

  it("walks backwards from the draft through every entry", () => {
    expect(
      stepMessageHistory({ history, index: DRAFT_HISTORY_INDEX, direction: "older", draft: "" }),
    ).toEqual({ index: 0, text: "newest" });
    expect(stepMessageHistory({ history, index: 0, direction: "older", draft: "" })).toEqual({
      index: 1,
      text: "middle",
    });
    expect(stepMessageHistory({ history, index: 1, direction: "older", draft: "" })).toEqual({
      index: 2,
      text: "oldest",
    });
  });

  it("stops at the oldest entry instead of wrapping", () => {
    expect(stepMessageHistory({ history, index: 2, direction: "older", draft: "" })).toBeNull();
  });

  it("restores the held draft when walking forward past the newest entry", () => {
    expect(
      stepMessageHistory({ history, index: 0, direction: "newer", draft: "half typed" }),
    ).toEqual({ index: DRAFT_HISTORY_INDEX, text: "half typed" });
  });

  it("does nothing when already on the draft", () => {
    expect(
      stepMessageHistory({ history, index: DRAFT_HISTORY_INDEX, direction: "newer", draft: "" }),
    ).toBeNull();
  });

  it("does nothing when there is no history", () => {
    expect(
      stepMessageHistory({
        history: [],
        index: DRAFT_HISTORY_INDEX,
        direction: "older",
        draft: "",
      }),
    ).toBeNull();
  });
});

describe("shouldEnterMessageHistory", () => {
  it("enters from an empty composer", () => {
    expect(shouldEnterMessageHistory({ value: "", index: DRAFT_HISTORY_INDEX })).toBe(true);
    expect(shouldEnterMessageHistory({ value: "   ", index: DRAFT_HISTORY_INDEX })).toBe(true);
  });

  it("leaves a composer the user is typing in alone", () => {
    expect(shouldEnterMessageHistory({ value: "half typed", index: DRAFT_HISTORY_INDEX })).toBe(
      false,
    );
  });

  it("keeps walking once history is already open, even though the input is not empty", () => {
    expect(shouldEnterMessageHistory({ value: "newest", index: 0 })).toBe(true);
  });
});
