/**
 * Where each source row sits in the list.
 *
 * A row is one visual line of code tall, and a line too long for the available columns wraps onto
 * more of them. The virtualized list is told these offsets so it can jump straight to a match
 * thousands of lines in; if they claim one visual line per row, an ordinary source file — whose
 * lines routinely wrap on a phone — puts the match hundreds of lines off screen.
 */
export interface SourceRowGeometry {
  /** Monospace characters that fit beside the gutter; 0 before the first measurement. */
  columns: number;
  /** Height of one visual line, already rounded the way the device rounds it. */
  visualLineHeight: number;
}

/**
 * Visual lines a line of code occupies, wrapped the way the platform wraps it: greedily at spaces,
 * and mid-word only for a word too long to fit a line of its own. Dividing the character count by
 * the column count instead under-counts every line that has to break early at a space, and the
 * error compounds over a long file. One line until the column width has been measured.
 */
export function visualLineCount(text: string, columns: number): number {
  if (columns <= 0) return 1;
  let rows = 1;
  let used = 0;
  for (const word of text.split(" ")) {
    const gap = used === 0 ? 0 : 1;
    if (used + gap + word.length <= columns) {
      used += gap + word.length;
      continue;
    }
    if (used > 0) rows += 1;
    if (word.length > columns) {
      rows += Math.ceil(word.length / columns) - 1;
      used = word.length % columns || columns;
      continue;
    }
    used = word.length;
  }
  return rows;
}

/** Cumulative top edge of every row, with one extra entry for the end of the last row. */
export function sourceRowOffsets(
  lines: ReadonlyArray<{ text: string }>,
  geometry: SourceRowGeometry,
): Float64Array {
  const stops = new Float64Array(lines.length + 1);
  for (let index = 0; index < lines.length; index += 1) {
    stops[index + 1] =
      stops[index] +
      visualLineCount(lines[index].text, geometry.columns) * geometry.visualLineHeight;
  }
  return stops;
}
