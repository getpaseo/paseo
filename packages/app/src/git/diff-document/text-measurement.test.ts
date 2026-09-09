import { describe, expect, it } from "vitest";
import {
  createCachedAsciiTextMetrics,
  createFallbackAwareTextMeasurer,
  createMeasuredAdvances,
  requiresShaping,
  type PrimaryTextFace,
} from "./text-measurement";

describe.each(["ios", "android"])("%s native text measurement", (platform) => {
  it("routes CJK and emoji missing glyphs through the system fallback shaper", () => {
    const fallbackInputs: string[] = [];
    const measurer = createFallbackAwareTextMeasurer({
      primary: primaryFaceWithout("中", "👨‍👩‍👧‍👦"),
      measureWithSystemFallback(text) {
        fallbackInputs.push(text);
        return platform === "ios" ? 24 : 22;
      },
    });

    expect(measurer.measure("中")).toBe(platform === "ios" ? 24 : 22);
    expect(measurer.measure("👨‍👩‍👧‍👦")).toBe(platform === "ios" ? 24 : 22);
    expect(fallbackInputs).toEqual(["中", "👨‍👩‍👧‍👦"]);
  });

  it("keeps combining graphemes intact when the primary face supports them", () => {
    const measurer = createFallbackAwareTextMeasurer({
      primary: primaryFaceWithout(),
      measureWithSystemFallback: () => 99,
    });
    expect(measurer.measure("é")).toBe(20);
  });
});

describe("native paragraph retention", () => {
  it("keeps ordinary code on the allocation-free font path", () => {
    expect(requiresShaping("const answer = value + 1;")).toBe(false);
  });

  it.each(["value => next", "中", "e\u0301", "👩‍💻", "مرحبا"])("retains shaping for %s", (text) => {
    expect(requiresShaping(text)).toBe(true);
  });
});

describe("cached ASCII text metrics", () => {
  it("measures each distinct grapheme once across lines", () => {
    const measured: string[] = [];
    const metrics = createCachedAsciiTextMetrics({
      glyphIds: (text) => Array.from(text, () => 1),
      measure(text) {
        measured.push(text);
        return text.length * 10;
      },
    });

    expect(metrics.measureAdvances(["a", "b", "a"])).toEqual([10, 20, 30]);
    expect(metrics.measureAdvances(["b", "a"])).toEqual([10, 20]);
    expect(metrics.measure("abba")).toBe(40);
    expect(measured).toEqual(["a", "b"]);
  });

  it("caches glyph coverage per distinct ASCII character", () => {
    const checked: string[] = [];
    const metrics = createCachedAsciiTextMetrics({
      glyphIds(text) {
        checked.push(text);
        return [text === "?" ? 0 : 1];
      },
      measure: (text) => text.length * 10,
    });

    expect(metrics.hasEveryGlyph("abba")).toBe(true);
    expect(metrics.hasEveryGlyph("bad?")).toBe(false);
    expect(metrics.hasEveryGlyph("cab")).toBe(true);
    expect(checked).toEqual(["a", "b", "d", "?", "c"]);
  });
});

describe("chunked advance measurement", () => {
  /**
   * A face where every character is 10 wide, except that each ligature pair
   * fuses into a single 12-wide glyph. Splitting a pair across two shaped runs
   * would measure it as 20 and drift every advance after it.
   */
  const LIGATURES = new Set(["=>", "==", "->"]);
  function shapingMeasure(text: string): number {
    let width = 0;
    for (let index = 0; index < text.length; ) {
      if (LIGATURES.has(text.slice(index, index + 2))) {
        width += 12;
        index += 2;
      } else {
        width += 10;
        index += 1;
      }
    }
    return width;
  }

  function advancesOf(text: string): number[] {
    return createMeasuredAdvances(shapingMeasure)(Array.from(text));
  }

  function expected(text: string): number[] {
    return Array.from(text, (_, index) => shapingMeasure(text.slice(0, index + 1)));
  }

  it("measures short runs in one shaping context", () => {
    expect(advancesOf("a => b")).toEqual(expected("a => b"));
  });

  it("keeps a ligature intact when it straddles a chunk boundary", () => {
    // Place the ligature so the unsnapped 64-grapheme boundary lands inside it.
    for (const offset of [62, 63, 64, 65]) {
      const text = `${"a".repeat(offset)}=>${"b".repeat(40)}`;
      expect(advancesOf(text), `ligature at ${offset}`).toEqual(expected(text));
    }
  });

  it("measures long ligature-dense source without drift at any boundary", () => {
    const text = "const f = (a) => a == 1; ".repeat(20);
    expect(advancesOf(text)).toEqual(expected(text));
  });

  it("stays on the additive path for long context-free source", () => {
    const measured: string[] = [];
    const advances = createMeasuredAdvances((text) => {
      measured.push(text);
      return text.length * 10;
    })(Array.from("abc ".repeat(64)));

    expect(advances.at(-1)).toBe(256 * 10);
    // Each distinct grapheme measured once, never a prefix.
    expect(measured).toEqual(["a", "b", "c", " "]);
  });
});

function primaryFaceWithout(...missing: string[]): PrimaryTextFace {
  return {
    glyphIds(text) {
      const isMissing = missing.some((candidate) => text.includes(candidate));
      return Array.from(text, () => (isMissing ? 0 : 1));
    },
    measure(text) {
      return Array.from(text).length * 10;
    },
  };
}
