import { PANDA_GRID, PANDA_PALETTE } from "@/components/panda-frames";

export { PANDA_GRID };

export interface PandaRun {
  x: number;
  y: number;
  width: number;
  fill: string;
}

/** Same-colour pixels of a row merge into one rect, far fewer shapes than pixels. */
export function buildPandaRuns(
  frame: readonly string[],
  palette: Record<string, string> = PANDA_PALETTE,
): PandaRun[] {
  const runs: PandaRun[] = [];
  frame.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const cell = row[x]!;
      const fill = palette[cell];
      if (cell === "." || !fill) {
        x += 1;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === cell) end += 1;
      runs.push({ x, y, width: end - x, fill });
      x = end;
    }
  });
  return runs;
}
