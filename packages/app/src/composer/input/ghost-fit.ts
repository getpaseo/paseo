// Width is estimated, never measured per glyph, so both ratios are deliberately
// pessimistic: a suggestion near the edge counts as not fitting.
const NARROW_CHAR_WIDTH_RATIO = 0.62;
const WIDE_CHAR_WIDTH_RATIO = 1.1;
const HINT_ALLOWANCE_PX = 28;

// East Asian Wide and Fullwidth blocks plus emoji, where one code point is about
// a full em rather than the 0.62 a Latin glyph averages.
const WIDE_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff],
  [0x20000, 0x3fffd],
];

export interface GhostFitInput {
  text: string;
  rowWidth: number | null;
  fontSize: number;
  hintVisible: boolean;
}

function isWideCodePoint(codePoint: number): boolean {
  return WIDE_CODE_POINT_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

export function estimateGhostWidthPx(text: string, fontSize: number): number {
  let ems = 0;
  for (const character of text) {
    ems += isWideCodePoint(character.codePointAt(0) ?? 0)
      ? WIDE_CHAR_WIDTH_RATIO
      : NARROW_CHAR_WIDTH_RATIO;
  }
  return ems * fontSize;
}

// False whenever the ghost might be ellipsised, including before its row has
// been measured, because Enter sends the ghost exactly as written.
export function ghostFitsOnOneLine(input: GhostFitInput): boolean {
  if (!input.rowWidth || input.rowWidth <= 0) return false;
  const available = input.rowWidth - (input.hintVisible ? HINT_ALLOWANCE_PX : 0);
  if (available <= 0) return false;
  return estimateGhostWidthPx(input.text, input.fontSize) <= available;
}

// The focus hint and the ghost share the strip at the end of the input row, so
// only one may claim it; the ghost is the actionable one.
export function shouldShowFocusHint(input: {
  isWeb: boolean;
  isInputFocused: boolean;
  hasValue: boolean;
  hasGhost: boolean;
}): boolean {
  return input.isWeb && !input.isInputFocused && !input.hasValue && !input.hasGhost;
}
