import { describe, expect, it } from "vitest";
import {
  hasPointerDragStarted,
  lineSelectionForDrag,
  wordSelectionForDrag,
  type LineAtPosition,
  type WordAtPosition,
} from "./pointer-gesture";
import type { DiffCharacterPosition } from "./types";

function positionAt(offset: number, rowIndex = 1, cellIndex = 0): DiffCharacterPosition {
  return { fileIndex: 0, rowIndex, cellIndex, side: "new", sourceOffset: offset };
}

function wordAt(
  input: { offset: number; start: number; end: number },
  rowIndex = 1,
  cellIndex = 0,
): WordAtPosition {
  return {
    position: positionAt(input.offset, rowIndex, cellIndex),
    word: { start: input.start, end: input.end },
  };
}

function lineAt(
  input: { offset: number; end: number },
  rowIndex = 1,
  cellIndex = 0,
): LineAtPosition {
  return {
    position: positionAt(input.offset, rowIndex, cellIndex),
    end: input.end,
  };
}

describe("diff pointer gesture", () => {
  it("classifies pointer movement as a drag without requiring a character change", () => {
    expect(
      hasPointerDragStarted({
        startX: 10,
        startY: 10,
        x: 15,
        y: 10,
        alreadyDragging: false,
      }),
    ).toBe(true);
  });

  it("keeps a gesture classified as a drag after it crosses the threshold", () => {
    expect(
      hasPointerDragStarted({
        startX: 10,
        startY: 10,
        x: 10,
        y: 10,
        alreadyDragging: true,
      }),
    ).toBe(true);
  });
});

describe("diff word drag selection", () => {
  it("extends forward from the start of the anchor word to the end of the focus word", () => {
    expect(
      wordSelectionForDrag({
        anchor: wordAt({ offset: 8, start: 6, end: 11 }),
        focus: wordAt({ offset: 14, start: 12, end: 19 }),
      }),
    ).toEqual({
      anchor: positionAt(6),
      focus: positionAt(19),
    });
  });

  it("extends backward from the end of the anchor word to the start of the focus word", () => {
    expect(
      wordSelectionForDrag({
        anchor: wordAt({ offset: 15, start: 13, end: 20 }),
        focus: wordAt({ offset: 7, start: 6, end: 11 }),
      }),
    ).toEqual({
      anchor: positionAt(6),
      focus: positionAt(20),
    });
  });

  it("keeps the anchor word whole while the pointer stays inside it", () => {
    const anchor = wordAt({ offset: 10, start: 6, end: 11 });
    const expected = { anchor: positionAt(6), focus: positionAt(11) };
    expect(
      wordSelectionForDrag({ anchor, focus: wordAt({ offset: 7, start: 6, end: 11 }) }),
    ).toEqual(expected);
    expect(
      wordSelectionForDrag({ anchor, focus: wordAt({ offset: 9, start: 6, end: 11 }) }),
    ).toEqual(expected);
  });

  it("snaps both ends to word boundaries across rows", () => {
    expect(
      wordSelectionForDrag({
        anchor: wordAt({ offset: 3, start: 2, end: 5 }, 1),
        focus: wordAt({ offset: 2, start: 0, end: 4 }, 3),
      }),
    ).toEqual({
      anchor: positionAt(2, 1),
      focus: positionAt(4, 3),
    });
    expect(
      wordSelectionForDrag({
        anchor: wordAt({ offset: 2, start: 0, end: 4 }, 3),
        focus: wordAt({ offset: 3, start: 2, end: 5 }, 1),
      }),
    ).toEqual({
      anchor: positionAt(2, 1),
      focus: positionAt(4, 3),
    });
  });
});

describe("diff line drag selection", () => {
  it("selects the whole clicked source line", () => {
    expect(
      lineSelectionForDrag({
        anchor: lineAt({ offset: 3, end: 12 }),
        focus: lineAt({ offset: 3, end: 12 }),
      }),
    ).toEqual({
      anchor: positionAt(0),
      focus: positionAt(12),
    });
  });

  it("extends forward to the end of the focus line while keeping the anchor line", () => {
    expect(
      lineSelectionForDrag({
        anchor: lineAt({ offset: 3, end: 12 }),
        focus: lineAt({ offset: 1, end: 7 }, 3),
      }),
    ).toEqual({
      anchor: positionAt(0),
      focus: positionAt(7, 3),
    });
  });

  it("extends backward from the start of the focus line to the end of the anchor line", () => {
    expect(
      lineSelectionForDrag({
        anchor: lineAt({ offset: 5, end: 9 }, 3),
        focus: lineAt({ offset: 2, end: 12 }, 1),
      }),
    ).toEqual({
      anchor: positionAt(0, 1),
      focus: positionAt(9, 3),
    });
  });
});
