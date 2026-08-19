import type { TextMeasurer } from "./types";

export interface PrimaryTextFace {
  glyphIds(text: string): number[];
  measure(text: string): number;
}

export interface CachedAsciiTextMetrics {
  hasEveryGlyph(text: string): boolean;
  measureAdvances(graphemes: readonly string[]): number[];
}

const CODE_LIGATURE_CANDIDATE = /(?:===?|!==?|=>|<=|>=|->|::|\+\+|--)/;

export function requiresNativeParagraph(text: string): boolean {
  return /[^\x20-\x7e\t]/u.test(text) || CODE_LIGATURE_CANDIDATE.test(text);
}

export function createCachedAsciiTextMetrics(primary: PrimaryTextFace): CachedAsciiTextMetrics {
  const glyphCoverage = new Map<string, boolean>();
  const widths = new Map<string, number>();
  return {
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
    measureAdvances(graphemes) {
      let advance = 0;
      return graphemes.map((grapheme) => {
        let width = widths.get(grapheme);
        if (width === undefined) {
          width = primary.measure(grapheme);
          widths.set(grapheme, width);
        }
        advance += width;
        return advance;
      });
    },
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
