import { describe, expect, it } from "vitest";
import { insertAtSelection } from "./insert-text";

describe("insertAtSelection", () => {
  it("inserts at the caret and moves the caret after the insertion", () => {
    expect(insertAtSelection({ text: "ab", selection: { start: 1, end: 1 } }, "XY")).toEqual({
      text: "aXYb",
      selection: { start: 3, end: 3 },
    });
  });

  it("replaces the selection, however it was dragged", () => {
    expect(insertAtSelection({ text: "abcd", selection: { start: 3, end: 1 } }, "-")).toEqual({
      text: "a-d",
      selection: { start: 2, end: 2 },
    });
  });
});
