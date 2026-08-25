/**
 * Terminal color palette.
 *
 * Maps to xterm.js theme tokens. Phase 1 uses a fixed dark theme
 * matching Paseo's default terminal appearance.
 */

export class TerminalColors {
  // Standard 16 ANSI colors
  static readonly fg: string[] = [
    '#0A0A0A',  // 0: Black
    '#CD3131',  // 1: Red
    '#0DBC79',  // 2: Green
    '#E5E510',  // 3: Yellow
    '#2472C8',  // 4: Blue
    '#BC3FBC',  // 5: Magenta
    '#11A8CD',  // 6: Cyan
    '#E5E5E5',  // 7: White
    '#666666',  // 8: Bright Black
    '#F14C4C',  // 9: Bright Red
    '#23D18B',  // 10: Bright Green
    '#F5F543',  // 11: Bright Yellow
    '#3B8EEA',  // 12: Bright Blue
    '#D670D6',  // 13: Bright Magenta
    '#29B8DB',  // 14: Bright Cyan
    '#E5E5E5',  // 15: Bright White
  ];

  /** Default foreground (ANSI default). */
  static readonly defaultFg = '#EDEDED';

  /** Default background. */
  static readonly defaultBg = '#0A0A0A';

  /** Cursor color. */
  static readonly cursor = '#EDEDED';

  /** Selection color. */
  static readonly selection = '#20744A66';

  /**
   * Get the foreground color for an SGR color code (0-255).
   * Phase 1 only handles the 16 standard colors.
   */
  static getFg(index: number): string {
    if (index >= 0 && index < 16) {
      return TerminalColors.fg[index];
    }
    return TerminalColors.defaultFg;
  }

  /** Get the background color for an SGR color code. */
  static getBg(index: number): string {
    if (index >= 0 && index < 16) {
      return TerminalColors.fg[index];
    }
    return TerminalColors.defaultBg;  // Background defaults to terminal bg if index is fg-like
  }
}
