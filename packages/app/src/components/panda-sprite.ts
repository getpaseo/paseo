// k = black, w = white, o = outline (mid grey so the panda reads on light and dark), . = empty.
const HEAD = [
  "..kk......kk..",
  ".kkkk....kkkk.",
  ".kkkwwwwwwkkk.",
  "owwwwwwwwwwwwo",
  "owwkkkwwkkkwwo",
  "owwkEkwwkEkwwo",
  "owwkkkwwkkkwwo",
  "owwwwwkkwwwwwo",
  "owwwwkwwkwwwwo",
  "owwwwwkkwwwwwo",
  ".owwwwwwwwwwo.",
  "..oooooooooo..",
];

const PALETTE = { k: "#1c1c1f", w: "#f5f5f5", o: "#8f8f99" } as const;

export const PANDA_COLUMNS = HEAD[0]!.length;
export const PANDA_ROWS = HEAD.length;

export interface PandaFrame {
  /** Whole-sprite bob in pixels, so the panda seems to breathe. */
  offsetY: number;
  eyesOpen: boolean;
}

// The blink lands on the low point of the bob.
export const PANDA_FRAMES: readonly PandaFrame[] = [
  { offsetY: 0, eyesOpen: true },
  { offsetY: 1, eyesOpen: true },
  { offsetY: 0, eyesOpen: true },
  { offsetY: 1, eyesOpen: false },
];

export interface PandaRun {
  x: number;
  y: number;
  width: number;
  fill: string;
}

/** Same-colour pixels of a row merge into one rect, ~60 instead of ~170 shapes. */
export function buildPandaRuns(frame: PandaFrame): PandaRun[] {
  const runs: PandaRun[] = [];
  HEAD.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const cell = row[x]!;
      const kind = resolve(cell, frame);
      if (kind === ".") {
        x += 1;
        continue;
      }
      let end = x + 1;
      while (end < row.length && resolve(row[end]!, frame) === kind) end += 1;
      runs.push({
        x,
        y: y + frame.offsetY,
        width: end - x,
        fill: PALETTE[kind as keyof typeof PALETTE],
      });
      x = end;
    }
  });
  return runs;
}

function resolve(cell: string, frame: PandaFrame): string {
  if (cell !== "E") return cell;
  return frame.eyesOpen ? "w" : "k";
}
