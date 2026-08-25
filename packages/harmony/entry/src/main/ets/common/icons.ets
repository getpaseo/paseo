/**
 * Icon glyphs for Paseo HarmonyOS.
 *
 * Uses Unicode symbols / system-provided icon resources where possible.
 * For a full icon set, integrate with HarmonyOS SymbolGlyph or custom SVG.
 * Phase 1 uses simple text glyphs and Unicode characters.
 *
 * Replace with proper icon resources in Phase 2.
 */

export class Icons {
  // Navigation
  static readonly BACK = '\u2190';        // ←
  static readonly CLOSE = '\u2715';       // ✕
  static readonly SETTINGS = '\u2699';    // ⚙

  // Agent
  static readonly SEND = '\u2191';        // ↑
  static readonly STOP = '\u25A0';        // ■
  static readonly REFRESH = '\u21BB';     // ↻

  // Status
  static readonly CONNECTED = '\u25CF';   // ●  (green)
  static readonly DISCONNECTED = '\u25CB'; // ○  (gray)
  static readonly ERROR = '\u26A0';       // ⚠

  // Terminal
  static readonly TERMINAL = '>_';
  static readonly COPY = '\u2398';        // ⎘

  // File / tool
  static readonly FILE = '\u1F4C4';       // 📄
  static readonly TOOL = '\u2692';        // ⚒
  static readonly SEARCH = '\u1F50D';     // 🔍

  // Provider
  static readonly CHEVRON_DOWN = '\u25BC';  // ▼
  static readonly CHEVRON_RIGHT = '\u25B6'; // ▶
  static readonly KEBAB = '\u22EE';         // ⋮
}
