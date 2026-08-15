import type { Terminal } from "@xterm/xterm";

/**
 * Word-level shaping ranges for fonts whose behavior lives in OpenType contextual
 * features (`calt`), such as Fast-Font. xterm renders each cell in isolation, so a
 * character joiner must hand whole words to the renderer as a single unit for the
 * platform shaper (HarfBuzz/CoreText) to apply the font's own contextual rules.
 *
 * The joiner intentionally does not parse the font: contextual fonts regularly use
 * GSUB constructs that JS font parsers in this dependency tree do not support
 * (Fast-Font's `calt` uses extension-wrapped format-3 chains, which both
 * `font-ligatures` and `opentype.js` fail to read). The renderer's own shaper
 * handles them fine as long as runs are joined.
 */

// Letter and number runs (plus underscore so identifiers stay whole; the font's
// own classes decide where substitutions actually apply inside the run). Word
// characters only: CJK/emoji/wide glyphs are left to per-cell rendering.
const WORD_RUN = /[\p{L}\p{N}_]+/gu;

export function terminalWordShapingRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const match of text.matchAll(WORD_RUN)) {
    const start = match.index;
    const end = start + match[0].length;
    // Single characters render identically either way; skipping them avoids
    // pointless joined-glyph atlas entries.
    if (end - start > 1) {
      ranges.push([start, end]);
    }
  }
  return ranges;
}

export function enableTerminalWordShaping(terminal: Terminal): () => void {
  const joinerId = terminal.registerCharacterJoiner(terminalWordShapingRanges);
  return () => {
    terminal.deregisterCharacterJoiner(joinerId);
  };
}
