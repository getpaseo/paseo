import type { TextMeasurer } from "./types";

export interface PrimaryTextFace {
  glyphIds(text: string): number[];
  measure(text: string): number;
}

export interface CachedAsciiTextMetrics {
  /** Whole-line width after checking glyph coverage and excluding shaping. */
  measure(text: string): number;
  hasEveryGlyph(text: string): boolean;
  measureAdvances(graphemes: readonly string[]): number[];
}

const CODE_LIGATURE_CANDIDATE = /(?:===?|!==?|=>|<=|>=|->|::|\+\+|--)/;

export function requiresShaping(text: string): boolean {
  return /[^\x20-\x7e\t]/u.test(text) || CODE_LIGATURE_CANDIDATE.test(text);
}

/**
 * Longest run handed to a shaper in one piece.
 *
 * Every backend that can only measure a whole string costs O(run length) per
 * cumulative advance, so measuring a run of n graphemes shapes n^2/2 characters.
 * A diff line is not bounded by anything -- a minified bundle checked into the
 * repo produces single lines over a megabyte long, which shapes for hours. Runs
 * are therefore capped, which trades a bounded seam error at chunk boundaries
 * for linear cost.
 */
const SHAPED_RUN_LIMIT = 64;

/** How far a chunk boundary may slide back to land where shaping cannot join. */
const BOUNDARY_SEARCH_LIMIT = 16;

/** Characters that code fonts fuse into ligature glyphs. */
const LIGATURE_JOINING = /[=!<>+\-:&|*/~^?.]/;

export interface ShapedAdvances {
  /** True when `text` needs a real shaper: per-grapheme advances are not additive. */
  requiresShaping(text: string): boolean;
  /** Cumulative advances summed from per-grapheme widths. */
  measureAdditive(graphemes: readonly string[]): number[];
  /** Cumulative advances for the whole run, measured in one shaping context. */
  measureShaped(graphemes: readonly string[]): number[];
}

export function createChunkedAdvanceMeasurer(
  advances: ShapedAdvances,
): (graphemes: readonly string[]) => number[] {
  return (graphemes) => {
    const result = Array.from<number>({ length: graphemes.length });
    let base = 0;
    let start = 0;
    while (start < graphemes.length) {
      const end = chunkEnd(graphemes, start);
      const chunk = graphemes.slice(start, end);
      const measured = advances.requiresShaping(chunk.join(""))
        ? advances.measureShaped(chunk)
        : advances.measureAdditive(chunk);
      for (let index = 0; index < chunk.length; index += 1) {
        result[start + index] = base + (measured[index] ?? 0);
      }
      base = result[end - 1] ?? base;
      start = end;
    }
    return result;
  };
}

/**
 * Advance measurement for a backend that can only measure a whole string, which
 * is every backend except a native paragraph shaper.
 */
export function createMeasuredAdvances(
  measure: (text: string) => number,
): (graphemes: readonly string[]) => number[] {
  return createChunkedAdvanceMeasurer({
    requiresShaping,
    measureAdditive: createAdditiveAdvances(measure),
    measureShaped: (graphemes) => measurePrefixAdvances(graphemes, measure),
  });
}

const measurerAdvances = new WeakMap<TextMeasurer, (graphemes: readonly string[]) => number[]>();

/** Advance measurement for `measurer`, defaulting backends that supply none. */
export function advancesFor(measurer: TextMeasurer): (graphemes: readonly string[]) => number[] {
  const existing = measurerAdvances.get(measurer);
  if (existing) return existing;
  const resolved = measurer.measureAdvances
    ? measurer.measureAdvances.bind(measurer)
    : createMeasuredAdvances((text) => measurer.measure(text));
  measurerAdvances.set(measurer, resolved);
  return resolved;
}

/** Cumulative advances summed from per-grapheme widths, each measured once. */
export function createAdditiveAdvances(
  measure: (text: string) => number,
): (graphemes: readonly string[]) => number[] {
  return additiveAdvances(cachedWidths(measure));
}

function cachedWidths(measure: (text: string) => number): (text: string) => number {
  const widths = new Map<string, number>();
  return (text) => {
    let width = widths.get(text);
    if (width === undefined) {
      width = measure(text);
      widths.set(text, width);
    }
    return width;
  };
}

function additiveAdvances(
  measure: (text: string) => number,
): (graphemes: readonly string[]) => number[] {
  return (graphemes) => {
    let advance = 0;
    return graphemes.map((grapheme) => (advance += measure(grapheme)));
  };
}

export function createCachedAsciiTextMetrics(primary: PrimaryTextFace): CachedAsciiTextMetrics {
  const glyphCoverage = new Map<string, boolean>();
  const measure = cachedWidths((text) => primary.measure(text));
  return {
    measure(text) {
      let width = 0;
      for (const character of text) width += measure(character);
      return width;
    },
    hasEveryGlyph(text) {
      for (const character of text) {
        let hasGlyph = glyphCoverage.get(character);
        if (hasGlyph === undefined) {
          hasGlyph = primary.glyphIds(character).every((glyph) => glyph !== 0);
          glyphCoverage.set(character, hasGlyph);
        }
        if (!hasGlyph) return false;
      }
      return true;
    },
    measureAdvances: additiveAdvances(measure),
  };
}

export function createFallbackAwareTextMeasurer(input: {
  primary: PrimaryTextFace;
  measureWithSystemFallback: (text: string) => number;
}): TextMeasurer {
  return {
    measure(text) {
      if (text.length === 0) return 0;
      const hasEveryGlyph = input.primary.glyphIds(text).every((glyph) => glyph !== 0);
      return hasEveryGlyph ? input.primary.measure(text) : input.measureWithSystemFallback(text);
    },
  };
}

function measurePrefixAdvances(
  graphemes: readonly string[],
  measure: (text: string) => number,
): number[] {
  let prefix = "";
  return graphemes.map((grapheme) => {
    prefix += grapheme;
    return measure(prefix);
  });
}

function chunkEnd(graphemes: readonly string[], start: number): number {
  const limit = start + SHAPED_RUN_LIMIT;
  if (limit >= graphemes.length) return graphemes.length;
  const floor = Math.max(start + 1, limit - BOUNDARY_SEARCH_LIMIT);
  for (let end = limit; end > floor; end -= 1) {
    if (splitsCleanly(graphemes[end - 1]) && splitsCleanly(graphemes[end])) return end;
  }
  return limit;
}

/**
 * Whether a boundary next to `grapheme` is one no shaper reaches across. Ligature
 * glyphs are fused from ASCII punctuation and complex scripts join within a word,
 * so a printable-ASCII grapheme carrying no ligature punctuation is a safe seam.
 */
function splitsCleanly(grapheme: string | undefined): boolean {
  if (grapheme === undefined) return true;
  return /^[\x20-\x7e]+$/.test(grapheme) && !LIGATURE_JOINING.test(grapheme);
}
