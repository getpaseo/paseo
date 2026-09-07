import { describe, expect, it } from "vitest";
import { insertDroppedText } from "./text-drop";

describe("insertDroppedText", () => {
  it("replaces the selected range and leaves the caret after the dropped text", () => {
    expect(
      insertDroppedText({
        droppedText: "the plan",
        input: { text: "review this now", selection: { start: 7, end: 11 } },
      }),
    ).toEqual({ text: "review the plan now", selection: { start: 15, end: 15 } });
  });

  it("inserts at the caret when nothing is selected", () => {
    expect(
      insertDroppedText({
        droppedText: "obsidian://open?vault=notes",
        input: { text: "open  please", selection: { start: 5, end: 5 } },
      }),
    ).toEqual({
      text: "open obsidian://open?vault=notes please",
      selection: { start: 32, end: 32 },
    });
  });

  it("appends when the caret sits past the end of a draft the input never reported", () => {
    expect(
      insertDroppedText({
        droppedText: "tail",
        input: { text: "head ", selection: { start: 99, end: 99 } },
      }),
    ).toEqual({ text: "head tail", selection: { start: 9, end: 9 } });
  });
});
