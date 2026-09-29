// k = black, w = white, o = outline (mid grey so the panda reads on light and dark),
// g/G = bamboo, b = thought dot, E = pupil (white open, black blinking), . = empty.
const BASE = [
  "....kk......kk....",
  "...kkkk....kkkk...",
  "...kkkwwwwwwkkk...",
  "..owwwwwwwwwwwwo..",
  "..owwkkkwwkkkwwo..",
  "..owwkEkwwkEkwwo..",
  "..owwkkkwwkkkwwo..",
  "..owwwwwkkwwwwwo..",
  "..owwwwkwwkwwwwo..",
  "..owwwwwkkwwwwwo..",
  "...owwwwwwwwwwo...",
  "....oooooooooo....",
  "..kkkowwwwwwokkk..",
  "..kkkwwwwwwwwkkk..",
  "...kkwwwwwwwwkk...",
  "....owwwwwwwwo....",
  "...kkkk....kkkk...",
  "...kkkk....kkkk...",
];

const PALETTE = {
  k: "#1c1c1f",
  w: "#f5f5f5",
  o: "#8f8f99",
  g: "#6fbf5b",
  G: "#3f8f3a",
  b: "#8f8f99",
} as const;

export const PANDA_COLUMNS = BASE[0]!.length;
export const PANDA_ROWS = BASE.length;
/** One spare row keeps the bob inside the box. */
export const PANDA_VIEW_ROWS = PANDA_ROWS + 1;

const BAMBOO_COLUMN = 16;
const MOUTH_ROW = 8;
const PUPIL_ROW = 5;
const PUPIL_COLUMNS = [6, 11];
const BUBBLE_ROW = 1;
const BUBBLE_FIRST_COLUMN = 15;

export interface PandaFrame {
  /** Whole-sprite bob in pixels, so the panda seems to breathe. */
  offsetY: number;
  eyesOpen: boolean;
  mouthOpen: boolean;
  /** The paw with the bamboo: up at the mouth or resting. */
  bambooUp: boolean;
  /** Thought dots 0..3, growing while the panda thinks. */
  thoughts: number;
}

// Chews bamboo while the thought bubble fills; blinks once mid-cycle.
export const PANDA_FRAMES: readonly PandaFrame[] = [
  { offsetY: 0, eyesOpen: true, mouthOpen: false, bambooUp: false, thoughts: 0 },
  { offsetY: 0, eyesOpen: true, mouthOpen: true, bambooUp: true, thoughts: 1 },
  { offsetY: 1, eyesOpen: true, mouthOpen: false, bambooUp: true, thoughts: 2 },
  { offsetY: 0, eyesOpen: true, mouthOpen: true, bambooUp: true, thoughts: 3 },
  { offsetY: 0, eyesOpen: false, mouthOpen: false, bambooUp: false, thoughts: 3 },
  { offsetY: 1, eyesOpen: true, mouthOpen: true, bambooUp: true, thoughts: 2 },
  { offsetY: 0, eyesOpen: true, mouthOpen: false, bambooUp: true, thoughts: 1 },
  { offsetY: 1, eyesOpen: true, mouthOpen: false, bambooUp: false, thoughts: 0 },
];

function paint(frame: PandaFrame): string[][] {
  const grid = BASE.map((row) => Array.from(row));
  const set = (x: number, y: number, cell: string) => {
    if (grid[y]?.[x] !== undefined) grid[y]![x] = cell;
  };
  for (const x of PUPIL_COLUMNS) set(x, PUPIL_ROW, frame.eyesOpen ? "w" : "k");
  if (frame.mouthOpen) {
    for (const x of [8, 9]) set(x, MOUTH_ROW, "k");
  }
  const bambooTop = frame.bambooUp ? 8 : 11;
  for (let y = bambooTop; y <= 14; y += 1)
    set(BAMBOO_COLUMN, y, (y - bambooTop) % 3 === 2 ? "G" : "g");
  for (let dot = 0; dot < frame.thoughts; dot += 1) set(BUBBLE_FIRST_COLUMN + dot, BUBBLE_ROW, "b");
  return grid;
}

export interface PandaRun {
  x: number;
  y: number;
  width: number;
  fill: string;
}

/** Same-colour pixels of a row merge into one rect, far fewer shapes than pixels. */
export function buildPandaRuns(frame: PandaFrame): PandaRun[] {
  const runs: PandaRun[] = [];
  paint(frame).forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const cell = row[x]!;
      if (cell === ".") {
        x += 1;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === cell) end += 1;
      runs.push({
        x,
        y: y + frame.offsetY,
        width: end - x,
        fill: PALETTE[cell as keyof typeof PALETTE],
      });
      x = end;
    }
  });
  return runs;
}
