import { comparePosition } from "./hit-testing";
import type { DiffCharacterPosition, DiffSelection } from "./types";
import type { SourceWordRange } from "./word-boundaries";

const DRAG_THRESHOLD = 4;

export interface WordAtPosition {
  position: DiffCharacterPosition;
  word: SourceWordRange;
}

export interface LineAtPosition {
  position: DiffCharacterPosition;
  /** UTF-16 length of the canonical source line. */
  end: number;
}

export function wordSelectionForDrag(input: {
  anchor: WordAtPosition;
  focus: WordAtPosition;
}): DiffSelection {
  const isBackward = comparePosition(input.focus.position, input.anchor.position) < 0;
  const start = isBackward ? input.focus : input.anchor;
  const end = isBackward ? input.anchor : input.focus;
  return {
    anchor: { ...start.position, sourceOffset: start.word.start },
    focus: { ...end.position, sourceOffset: end.word.end },
  };
}

export function lineSelectionForDrag(input: {
  anchor: LineAtPosition;
  focus: LineAtPosition;
}): DiffSelection {
  const isBackward = comparePosition(input.focus.position, input.anchor.position) < 0;
  const start = isBackward ? input.focus : input.anchor;
  const end = isBackward ? input.anchor : input.focus;
  return {
    anchor: { ...start.position, sourceOffset: 0 },
    focus: { ...end.position, sourceOffset: end.end },
  };
}

export function hasPointerDragStarted(input: {
  startX: number;
  startY: number;
  x: number;
  y: number;
  alreadyDragging: boolean;
}): boolean {
  if (input.alreadyDragging) return true;
  return Math.hypot(input.x - input.startX, input.y - input.startY) >= DRAG_THRESHOLD;
}
