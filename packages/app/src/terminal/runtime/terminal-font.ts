const DEFAULT_TERMINAL_FONT_SIZE = 13;

export const DEFAULT_TERMINAL_FONT_FAMILY = [
  // Prefer common developer fonts, with Nerd Font variants for prompt/TUI glyphs.
  "JetBrains Mono",
  "JetBrainsMono Nerd Font",
  "JetBrainsMono NF",
  "MesloLGM Nerd Font",
  "MesloLGM NF",
  "Hack Nerd Font",
  "FiraCode Nerd Font",
  // PUA-only fallback (many Nerd glyphs live here on some systems).
  "Symbols Nerd Font",
  // System fallbacks.
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "'Liberation Mono'",
  "monospace",
].join(", ");

const GENERIC_MONOSPACE_FAMILIES = new Set(["monospace", "ui-monospace"]);

/**
 * A user-entered family that the platform cannot resolve — a typo, or a font that
 * simply isn't installed — otherwise falls through to the browser's default
 * PROPORTIONAL font, which shreds the fixed grid: xterm gives every cell the same
 * advance, so proportional glyphs spread out and the cursor stops lining up. The
 * generic `monospace` keyword always resolves, so appending it keeps an
 * unresolvable name a cosmetic miss instead of a broken terminal.
 */
export function resolveTerminalFontFamily(fontFamily: string | undefined): string {
  const trimmed = fontFamily?.trim();
  if (!trimmed || trimmed.length === 0) {
    return DEFAULT_TERMINAL_FONT_FAMILY;
  }
  const lastFamily = trimmed
    .split(",")
    .at(-1)
    ?.trim()
    .replace(/^['"]|['"]$/g, "");
  if (lastFamily && GENERIC_MONOSPACE_FAMILIES.has(lastFamily.toLowerCase())) {
    return trimmed;
  }
  return `${trimmed}, monospace`;
}

export function resolveTerminalFontSize(fontSize: number | undefined): number {
  return typeof fontSize === "number" && Number.isFinite(fontSize) && fontSize > 0
    ? fontSize
    : DEFAULT_TERMINAL_FONT_SIZE;
}

export const DEFAULT_TERMINAL_LINE_HEIGHT = 1.2;
export const MIN_TERMINAL_LINE_HEIGHT = 1.0;
export const MAX_TERMINAL_LINE_HEIGHT = 2.0;

/**
 * Terminal line height is a multiplier on the cell height, not a px value: xterm
 * takes it as `lineHeight`, and the native grid multiplies its measured cell
 * height by it. Below 1.0 glyphs clip against the cell, so that is the floor.
 */
export function resolveTerminalLineHeight(lineHeight: number | undefined): number {
  if (typeof lineHeight !== "number" || !Number.isFinite(lineHeight)) {
    return DEFAULT_TERMINAL_LINE_HEIGHT;
  }
  return Math.min(MAX_TERMINAL_LINE_HEIGHT, Math.max(MIN_TERMINAL_LINE_HEIGHT, lineHeight));
}

/**
 * xterm draws bold SGR text in its `fontWeightBold` weight. Matching it to the normal
 * weight is what neutralizes bold — the escape codes still apply their colors, so
 * shell syntax highlighting keeps working, it just stops being heavy.
 */
export function resolveTerminalFontWeightBold(boldText: boolean | undefined): "bold" | "normal" {
  return boldText === false ? "normal" : "bold";
}
