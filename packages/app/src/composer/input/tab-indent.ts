export interface ComposerTabIndentInput {
  value: string;
  selectionStart: number | null | undefined;
  selectionEnd: number | null | undefined;
}

export interface ComposerTabIndentResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export function insertComposerTabIndent(input: ComposerTabIndentInput): ComposerTabIndentResult {
  const start = clampSelectionIndex(input.selectionStart, input.value.length);
  const end = clampSelectionIndex(input.selectionEnd, input.value.length);
  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);
  const cursor = selectionStart + 1;
  return {
    value: `${input.value.slice(0, selectionStart)}\t${input.value.slice(selectionEnd)}`,
    selectionStart: cursor,
    selectionEnd: cursor,
  };
}

function clampSelectionIndex(index: number | null | undefined, valueLength: number): number {
  if (typeof index !== "number") {
    return valueLength;
  }
  return Math.max(0, Math.min(index, valueLength));
}
