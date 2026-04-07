export interface ComposerSelection {
  start: number;
  end: number;
}

export interface InsertTextAtSelectionResult {
  text: string;
  selection: ComposerSelection;
}

function clampSelectionIndex(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(max, Math.trunc(value)));
}

function withTrailingInsertionSpace(input: {
  value: string;
  insertedText: string;
  selectionEnd: number;
}): string {
  const insertedText = input.insertedText ?? "";
  if (!insertedText || /\s$/.test(insertedText)) {
    return insertedText;
  }

  const nextCharacter = input.value.slice(input.selectionEnd, input.selectionEnd + 1);
  if (!nextCharacter || !/\s/.test(nextCharacter)) {
    return `${insertedText} `;
  }

  return insertedText;
}

export function insertTextAtSelection(input: {
  value: string;
  insertedText: string;
  selection: ComposerSelection;
}): InsertTextAtSelectionResult {
  const value = input.value ?? "";
  const start = clampSelectionIndex(input.selection.start, value.length);
  const end = clampSelectionIndex(input.selection.end, value.length);
  const selectionStart = Math.min(start, end);
  const selectionEnd = Math.max(start, end);
  const normalizedInsertedText = withTrailingInsertionSpace({
    value,
    insertedText: input.insertedText ?? "",
    selectionEnd,
  });
  const text =
    value.slice(0, selectionStart) +
    normalizedInsertedText +
    value.slice(selectionEnd, value.length);
  const cursor = selectionStart + normalizedInsertedText.length;

  return {
    text,
    selection: { start: cursor, end: cursor },
  };
}

export function buildComposerInsertResult(input: {
  value: string;
  token: string;
  selection: ComposerSelection;
  hasKnownSelection: boolean;
}): InsertTextAtSelectionResult {
  const token = input.token.trim();
  if (!token) {
    const clampedStart = clampSelectionIndex(input.selection.start, input.value.length);
    const clampedEnd = clampSelectionIndex(input.selection.end, input.value.length);
    return {
      text: input.value,
      selection: {
        start: Math.min(clampedStart, clampedEnd),
        end: Math.max(clampedStart, clampedEnd),
      },
    };
  }

  if (input.hasKnownSelection) {
    return insertTextAtSelection({
      value: input.value,
      insertedText: token,
      selection: input.selection,
    });
  }

  const text = appendTextTokenToComposer({
    value: input.value,
    token,
  });
  return {
    text,
    selection: {
      start: text.length,
      end: text.length,
    },
  };
}

export function appendTextTokenToComposer(input: { value: string; token: string }): string {
  const value = input.value ?? "";
  const token = input.token.trim();
  if (!token) {
    return value;
  }

  const leadingWhitespace = value.length > 0 && !/\s$/.test(value) ? " " : "";
  const trailingWhitespace = /\s$/.test(token) ? "" : " ";
  return `${value}${leadingWhitespace}${token}${trailingWhitespace}`;
}
