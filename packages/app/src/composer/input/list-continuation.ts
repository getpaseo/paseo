export interface ListContinuation {
  text: string;
  selection: { start: number; end: number };
}

// indent, marker ("-", "*", "+", "1." or "1)"), optional task box, rest of the line
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\](?:\s+|$))?(.*)$/;
const THEMATIC_BREAK = /^\s*([-*_])(\s*\1){2,}\s*$/;

function findInsertedNewline(previous: string, next: string, caret: number): number | null {
  if (next.length !== previous.length + 1) return null;
  // The caret may be reported before or after the edit, depending on the platform.
  for (const at of [caret, caret - 1]) {
    if (at >= 0 && next === `${previous.slice(0, at)}\n${previous.slice(at)}`) return at;
  }
  return null;
}

function isInsideCodeFence(textBefore: string): boolean {
  const fences = textBefore.split("\n").filter((line) => /^\s*(```|~~~)/.test(line));
  return fences.length % 2 === 1;
}

/**
 * When an edit inserts one newline at the end of a Markdown list item, continue the list on
 * the new line. A newline on an empty item ends the list and removes the marker.
 */
export function continueMarkdownList(
  previous: string,
  next: string,
  caret: number,
): ListContinuation | null {
  const at = findInsertedNewline(previous, next, caret);
  if (at === null) return null;
  const lineStart = previous.lastIndexOf("\n", at - 1) + 1;
  const line = previous.slice(lineStart, at);
  if (THEMATIC_BREAK.test(line)) return null;
  const match = LIST_ITEM.exec(line);
  if (!match || isInsideCodeFence(previous.slice(0, lineStart))) return null;
  const [, indent, marker, task, content] = match;

  if (content.trim() === "") {
    const lineEnd = previous.indexOf("\n", at);
    const restOfLine = previous.slice(at, lineEnd === -1 ? undefined : lineEnd);
    if (restOfLine.trim() !== "") return null;
    const text = previous.slice(0, lineStart) + previous.slice(at);
    return { text, selection: { start: lineStart, end: lineStart } };
  }

  const ordered = /^(\d+)([.)])$/.exec(marker);
  const nextMarker = ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : marker;
  const prefix = `${indent}${nextMarker} ${task ? "[ ] " : ""}`;
  const caretAfter = at + 1 + prefix.length;
  const text = `${previous.slice(0, at)}\n${prefix}${previous.slice(at).replace(/^[ \t]+/, "")}`;
  return { text, selection: { start: caretAfter, end: caretAfter } };
}
