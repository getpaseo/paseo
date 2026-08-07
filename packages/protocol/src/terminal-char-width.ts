// Terminals give East Asian wide characters two columns and follow them with a
// spacer cell. Cell payloads carry no width, so both the snapshot replay and the
// native renderer have to recover it from the character itself.
const WIDE_CHAR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
];

export function isWideTerminalChar(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }
  return WIDE_CHAR_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

export function terminalCharColumns(char: string): number {
  return isWideTerminalChar(char) ? 2 : 1;
}
