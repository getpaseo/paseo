/**
 * Pure logic for a number field you can type into or scrub by dragging sideways.
 * `ScrubScale` says where a value may go and how far one notch moves it; `ScrubFormat`
 * turns a value into the text in the field and back.
 */

/** A value, or null for "none" (no limit) on a nullable scale. */
export type ScrubValue = number | null;

export interface ScrubScale {
  min: number;
  max: number;
  /** One coarse notch, walked on a grid of its multiples. Unused by coarse moves when `ladder` is set. */
  step: number;
  /** One fine notch (Shift on web), walked on a grid of its multiples. Defaults to `step`. */
  fineStep?: number;
  /** Round values a coarse notch walks between, such as 5, 10, 15, 30 minutes. */
  ladder?: readonly number[];
  /** Below the lowest value is null. */
  nullable?: boolean;
  /** Pointer travel per notch. Defaults to `DEFAULT_PX_PER_NOTCH`. */
  pxPerNotch?: number;
}

export interface ScrubFormat {
  format: (value: number) => string;
  /** A number, null for empty text, or undefined when the text is not a value. */
  parse: (text: string) => ScrubValue | undefined;
}

export const DEFAULT_PX_PER_NOTCH = 10;

// Grid arithmetic on decimal steps (0.01) drifts; this absorbs it.
const EPSILON = 1e-9;

export function clampScrubValue(scale: ScrubScale, value: number): number {
  return Math.min(scale.max, Math.max(scale.min, value));
}

export function isScrubValueInRange(scale: ScrubScale, value: number): boolean {
  return value >= scale.min && value <= scale.max;
}

/** Whole notches for a pointer travel, toward zero: 19px at 10px a notch is one notch. */
export function scrubNotches(deltaPx: number, pxPerNotch = DEFAULT_PX_PER_NOTCH): number {
  const notches = Math.trunc(deltaPx / pxPerNotch);
  // Math.trunc(-0.5) is -0.
  return notches === 0 ? 0 : notches;
}

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

function ladderOf(scale: ScrubScale): number[] {
  return [...(scale.ladder ?? [])]
    .filter((value) => isScrubValueInRange(scale, value))
    .sort((a, b) => a - b);
}

function stepOnGrid(
  scale: ScrubScale,
  value: ScrubValue,
  notches: number,
  step: number,
): ScrubValue {
  if (value === null) {
    // The first notch up from none is the lowest value.
    return notches > 0 ? stepOnGrid(scale, scale.min, notches - 1, step) : null;
  }
  if (notches === 0) {
    return value;
  }
  // An off-grid value moves to the grid line in the direction of travel first.
  const base =
    notches > 0
      ? Math.floor(value / step + EPSILON) * step
      : Math.ceil(value / step - EPSILON) * step;
  const next = Number((base + notches * step).toFixed(decimalsOf(step)));
  if (next < scale.min) {
    if (value > scale.min) {
      return scale.min;
    }
    return scale.nullable ? null : scale.min;
  }
  return Math.min(scale.max, next);
}

function stepOnLadder(
  scale: ScrubScale,
  ladder: readonly number[],
  value: ScrubValue,
  notches: number,
): ScrubValue {
  if (value === null) {
    return notches > 0 ? (ladder[Math.min(notches, ladder.length) - 1] ?? null) : null;
  }
  if (notches > 0) {
    const above = ladder.filter((step) => step > value);
    return above[Math.min(notches, above.length) - 1] ?? value;
  }
  const below = ladder.filter((step) => step < value);
  const index = below.length + notches;
  if (index < 0) {
    if (scale.nullable) {
      return null;
    }
    return below[0] ?? value;
  }
  return below[index] ?? value;
}

/**
 * The value `notches` notches from `value`, held inside the scale. Coarse moves walk the ladder
 * when there is one; fine moves, and coarse moves without a ladder, walk a grid of the step.
 */
export function stepScrubValue(
  scale: ScrubScale,
  value: ScrubValue,
  notches: number,
  fine = false,
): ScrubValue {
  if (notches === 0) {
    return value;
  }
  const ladder = ladderOf(scale);
  if (!fine && ladder.length > 0) {
    return stepOnLadder(scale, ladder, value, notches);
  }
  return stepOnGrid(scale, value, notches, fine ? (scale.fineStep ?? scale.step) : scale.step);
}

/** The value a drag of `deltaPx` from `start` lands on. */
export function scrubValueFromDelta(
  scale: ScrubScale,
  start: ScrubValue,
  deltaPx: number,
  fine = false,
): ScrubValue {
  return stepScrubValue(scale, start, scrubNotches(deltaPx, scale.pxPerNotch), fine);
}

export interface ScrubSession {
  /** `deltaPx` is the travel since the drag began. Returns the value to show. */
  move: (deltaPx: number, fine: boolean) => ScrubValue;
}

/**
 * One drag. Switching between fine and coarse mid-drag continues from the current value
 * instead of jumping to where the other step size would have put it.
 */
export function createScrubSession(scale: ScrubScale, start: ScrubValue): ScrubSession {
  let anchor = start;
  let anchorPx = 0;
  let anchorFine = false;
  let current = start;
  return {
    move(deltaPx, fine) {
      if (fine !== anchorFine) {
        anchor = current;
        anchorPx = deltaPx;
        anchorFine = fine;
      }
      current = scrubValueFromDelta(scale, anchor, deltaPx - anchorPx, fine);
      return current;
    },
  };
}

// A decimal pad in a comma locale types "2,5". A lone comma that is not a thousands group
// ("1,000") is the decimal point.
const DECIMAL_COMMA = /^(\D*\d+),(\d{1,2}|\d{4,})(\D*)$/;

function normalizeNumberText(text: string): string {
  const compact = text.trim().replace(/[\s_]/g, "");
  return compact.replace(DECIMAL_COMMA, "$1.$2$3").replace(/,/g, "");
}

const DECIMAL = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

/** Plain numbers, as typed. `integer` refuses a fraction. */
export function plainNumberFormat(options: { integer?: boolean } = {}): ScrubFormat {
  return {
    format: (value) => String(value),
    parse(text) {
      const normalized = normalizeNumberText(text);
      if (!normalized) {
        return null;
      }
      if (!DECIMAL.test(normalized)) {
        return undefined;
      }
      const value = Number(normalized);
      if (options.integer && !Number.isInteger(value)) {
        return undefined;
      }
      return value;
    },
  };
}

const SECONDS_PER_UNIT = { s: 1, m: 60, h: 3600, d: 86_400 } as const;
type DurationSymbol = keyof typeof SECONDS_PER_UNIT;

const DURATION_SYMBOLS: Record<string, DurationSymbol> = {
  s: "s",
  sec: "s",
  secs: "s",
  second: "s",
  seconds: "s",
  m: "m",
  min: "m",
  mins: "m",
  minute: "m",
  minutes: "m",
  h: "h",
  hr: "h",
  hrs: "h",
  hour: "h",
  hours: "h",
  d: "d",
  day: "d",
  days: "d",
};

const NUMBER_WITH_UNIT = /^(\d+(?:\.\d+)?|\.\d+)([a-z]*)$/;

/**
 * A whole number of `base` units, shown in the largest unit it divides into ("90m", "2h", "1d").
 * Typing takes a number with an optional unit; a bare number is in `base`. Fractions round to a
 * whole `base` unit: "1.5h" is 90 minutes.
 */
export function durationFormat(base: "seconds" | "minutes"): ScrubFormat {
  const baseSeconds = base === "seconds" ? 1 : 60;
  const baseSymbol: DurationSymbol = base === "seconds" ? "s" : "m";
  const symbols: DurationSymbol[] = base === "seconds" ? ["d", "h", "m"] : ["d", "h"];
  return {
    format(value) {
      const seconds = value * baseSeconds;
      const symbol =
        symbols.find((candidate) => seconds > 0 && seconds % SECONDS_PER_UNIT[candidate] === 0) ??
        baseSymbol;
      return `${seconds / SECONDS_PER_UNIT[symbol]}${symbol}`;
    },
    parse(text) {
      const normalized = normalizeNumberText(text).toLowerCase();
      if (!normalized) {
        return null;
      }
      const match = normalized.match(NUMBER_WITH_UNIT);
      if (!match) {
        return undefined;
      }
      const symbol = match[2] ? DURATION_SYMBOLS[match[2]] : baseSymbol;
      if (!symbol) {
        return undefined;
      }
      return Math.round((Number(match[1]) * SECONDS_PER_UNIT[symbol]) / baseSeconds);
    },
  };
}

const COUNT_SUFFIXES = [
  ["B", 1e9],
  ["M", 1e6],
  ["k", 1e3],
] as const;

const COUNT_SIZES: Record<string, number> = { "": 1, k: 1e3, m: 1e6, b: 1e9 };

const NUMBER_WITH_COUNT_SUFFIX = /^(\d+(?:\.\d+)?|\.\d+)([kmb]?)$/;

/**
 * Whole counts with k/M/B suffixes ("250k", "1.5M"). A suffix is used only when it reads back
 * as the same number, so editing the text never loses precision.
 */
export function compactCountFormat(): ScrubFormat {
  return {
    format(value) {
      for (const [suffix, size] of COUNT_SUFFIXES) {
        if (Math.abs(value) < size) {
          continue;
        }
        const scaled = Number((value / size).toFixed(2));
        if (Math.round(scaled * size) === value) {
          return `${scaled}${suffix}`;
        }
      }
      return String(value);
    },
    parse(text) {
      const normalized = normalizeNumberText(text).toLowerCase();
      if (!normalized) {
        return null;
      }
      const match = normalized.match(NUMBER_WITH_COUNT_SUFFIX);
      if (!match) {
        return undefined;
      }
      return Math.round(Number(match[1]) * (COUNT_SIZES[match[2] ?? ""] ?? 1));
    },
  };
}

/** US dollars to the cent: "$5", "$2.50". A typed "$" is optional. */
export function usdFormat(): ScrubFormat {
  return {
    format: (value) => (Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`),
    parse(text) {
      const normalized = normalizeNumberText(text).replace(/^\$/, "");
      if (!normalized) {
        return null;
      }
      if (!DECIMAL.test(normalized)) {
        return undefined;
      }
      return Math.round(Number(normalized) * 100) / 100;
    },
  };
}
