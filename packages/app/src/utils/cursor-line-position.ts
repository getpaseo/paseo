/**
 * Returns true when the cursor sits on the first visual line of `value`.
 * The first line is the substring before the first `\n`. Position 0 in an
 * empty string also counts as "first line".
 */
export function isCursorOnFirstLine(value: string, cursorIndex: number): boolean {
  if (cursorIndex <= 0) return true;
  return value.lastIndexOf("\n", cursorIndex - 1) === -1;
}

/**
 * Returns true when the cursor sits on the last visual line of `value`.
 * The last line is the substring after the final `\n`. End-of-string also
 * counts as "last line".
 */
export function isCursorOnLastLine(value: string, cursorIndex: number): boolean {
  if (cursorIndex >= value.length) return true;
  return value.indexOf("\n", cursorIndex) === -1;
}
