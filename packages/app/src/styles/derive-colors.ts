/**
 * The relationships between theme colors, stated once.
 *
 * A theme supplies places (a background, a sidebar) and identity (foreground, accent). What sits
 * on top of a place — its hover, its selected state, the neutral fill of a chip, the text one
 * notch quieter than muted — is a relationship, and is derived here so that no theme has to pick
 * it by eye and no plugin has to borrow another role's color to fill it.
 *
 * Every step is a WCAG contrast ratio from the color it starts at, moving toward the foreground.
 * A ratio keeps the step equally visible on every base; a lightness delta disappears near black.
 * The numbers come from the default themes: Paseo dark and Light.
 */
import { contrastRatio, mixHexColors, stepContrast } from "@/utils/color";

export type ColorScheme = "light" | "dark";

const SURFACE_STATE_STEPS = {
  dark: { hover: 1.11, selected: 1.245 },
  light: { hover: 1.15, selected: 1.35 },
} as const;

// Fills for chips, bubbles, tracks and secondary buttons, as `surface3` and `surface4`.
const NEUTRAL_FILL_STEPS = {
  dark: { surface3: 1.8, surface4: 2.5 },
  light: { surface3: 1.27, surface4: 1.48 },
} as const;

// `surface3` carries text (message bubbles, secondary buttons, badges), so its step is bounded by
// the contrast the theme gives its own text: foreground stays at least this readable on it. The
// margin over 3:1 absorbs the rounding of the fill to 8-bit channels.
const NEUTRAL_FILL_TEXT_FLOOR = 3.05;
// The fill never steps less than this, so it stays visible against the page. A theme whose body
// text is under about 3.8:1 (3.05 x 1.25) cannot have both: the fill keeps this step and text on
// it falls under 3:1.
const NEUTRAL_FILL_MIN_STEP = 1.25;

// Tertiary text: muted text, that fraction of the way toward the background, but never quieter
// than this contrast against it (or than the muted text itself, when that is already quieter). The
// margin over 2.5:1 absorbs the rounding to 8-bit channels.
const TERTIARY_TEXT_FADE = 0.35;
const TERTIARY_TEXT_FLOOR = 2.55;

/** Hover and selected fills for a row that sits on `surface`. */
export function deriveSurfaceStates(
  surface: string,
  foreground: string,
  scheme: ColorScheme,
): { hover: string; selected: string } {
  const steps = SURFACE_STATE_STEPS[scheme];
  return {
    hover: stepContrast(surface, foreground, steps.hover),
    selected: stepContrast(surface, foreground, steps.selected),
  };
}

/** The neutral fills that sit on the page background. */
export function deriveNeutralFills(
  background: string,
  foreground: string,
  scheme: ColorScheme,
): { surface3: string; surface4: string } {
  const steps = NEUTRAL_FILL_STEPS[scheme];
  // Foreground on the fill is about (foreground on background) / step.
  const textBound = contrastRatio(background, foreground) / NEUTRAL_FILL_TEXT_FLOOR;
  return {
    surface3: stepContrast(
      background,
      foreground,
      Math.max(NEUTRAL_FILL_MIN_STEP, Math.min(steps.surface3, textBound)),
    ),
    surface4: stepContrast(background, foreground, steps.surface4),
  };
}

export function deriveTertiaryText(mutedForeground: string, background: string): string {
  const faded = mixHexColors(mutedForeground, background, TERTIARY_TEXT_FADE);
  const floor = Math.min(TERTIARY_TEXT_FLOOR, contrastRatio(background, mutedForeground));
  if (contrastRatio(background, faded) >= floor) return faded;
  return stepContrast(background, mutedForeground, floor);
}

/** Keep page tertiary text where it is readable; otherwise derive it against the row state. */
export function deriveSidebarStateText(
  tertiary: string,
  surface: string,
  foreground: string,
): string {
  if (contrastRatio(tertiary, surface) >= TERTIARY_TEXT_FLOOR) return tertiary;
  return stepContrast(surface, foreground, TERTIARY_TEXT_FLOOR);
}
