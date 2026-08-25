/**
 * Paseo design tokens mapped to ArkUI resource references.
 *
 * These mirror the theme values defined in docs/design.md and
 * packages/app/src/styles/. ArkUI handles dark/light switching
 * automatically via resource qualifiers (dark/element/ vs base/element/).
 *
 * Colors use hex values; fonts use system defaults with size scaling.
 */

export class PaseoTheme {
  // ---- Backgrounds ----
  static readonly bgPrimary = '#0A0A0A';       // Main background (dark)
  static readonly bgSecondary = '#141414';      // Card / secondary surface
  static readonly bgTertiary = '#1C1C1C';       // Elevated surface
  static readonly bgInverse = '#F5F5F5';        // Light background for contrast

  // ---- Text ----
  static readonly textPrimary = '#EDEDED';      // Primary body text
  static readonly textSecondary = '#999999';    // Muted / caption text
  static readonly textTertiary = '#666666';     // Very muted
  static readonly textInverse = '#0A0A0A';      // Dark text on light background

  // ---- Accent ----
  static readonly accent = '#20744A';           // Paseo green
  static readonly accentHover = '#268C58';      // Hover / active state
  static readonly danger = '#E5484D';           // Error / destructive actions
  static readonly warning = '#F5A623';          // Warning state

  // ---- Code / Terminal ----
  static readonly codeBg = '#111111';           // Code block background
  static readonly terminalBg = '#0A0A0A';       // Terminal background
  static readonly terminalFg = '#EDEDED';       // Terminal default foreground

  // ---- Borders ----
  static readonly border = '#2A2A2A';           // Subtle border
  static readonly borderStrong = '#3A3A3A';     // Stronger border

  // ---- Font sizes (in vp — virtual pixels) ----
  static readonly fontSizeXS = 11;
  static readonly fontSizeSM = 13;
  static readonly fontSizeMD = 15;
  static readonly fontSizeLG = 17;
  static readonly fontSizeXL = 20;
  static readonly fontSizeXXL = 24;

  // ---- Font families ----
  static readonly fontSans = 'HarmonyOS Sans';
  static readonly fontMono = 'HarmonyOS Sans Mono';   // Fallback: monospace

  // ---- Spacing (in vp) ----
  static readonly spaceXS = 4;
  static readonly spaceSM = 8;
  static readonly spaceMD = 12;
  static readonly spaceLG = 16;
  static readonly spaceXL = 24;
  static readonly spaceXXL = 32;

  // ---- Radii ----
  static readonly radiusSM = 4;
  static readonly radiusMD = 8;
  static readonly radiusLG = 12;
  static readonly radiusFull = 9999;

  // ---- Terminal ----
  static readonly terminalFontSize = 13;
  static readonly terminalLineHeight = 1.3;
}
