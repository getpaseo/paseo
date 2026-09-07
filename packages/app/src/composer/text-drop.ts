import type { ComposerInputSnapshot } from "@/composer/input/input";

interface InsertDroppedTextInput {
  droppedText: string;
  input: ComposerInputSnapshot;
}

// Clamped so a caret past the end appends — an untouched draft reports one.
export function insertDroppedText({
  droppedText,
  input,
}: InsertDroppedTextInput): ComposerInputSnapshot {
  const start = clampToText(Math.min(input.selection.start, input.selection.end), input.text);
  const end = clampToText(Math.max(input.selection.start, input.selection.end), input.text);
  const caret = start + droppedText.length;
  return {
    text: `${input.text.slice(0, start)}${droppedText}${input.text.slice(end)}`,
    selection: { start: caret, end: caret },
  };
}

function clampToText(index: number, text: string): number {
  return Math.max(0, Math.min(index, text.length));
}
