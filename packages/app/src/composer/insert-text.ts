import type { ComposerInputSnapshot } from "@/composer/input/input";

/** The text with `inserted` in place of the selection, and the caret after it. */
export function insertAtSelection(
  { text, selection }: ComposerInputSnapshot,
  inserted: string,
): ComposerInputSnapshot {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  const caret = start + inserted.length;
  return {
    text: text.slice(0, start) + inserted + text.slice(end),
    selection: { start: caret, end: caret },
  };
}
