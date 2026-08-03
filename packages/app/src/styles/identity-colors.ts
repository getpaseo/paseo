// Muted tones, all landing in a 4.2-4.8:1 contrast band against the white letter on top.
//
// Two properties matter more than the individual hues. First, low chroma: these squares sit
// in a sidebar row next to a status dot, a PR glyph and a diff stat, and at full saturation
// the project icon wins a fight it shouldn't be in. Second, even luminance: the previous set
// was raw Tailwind 500s spanning 1.9:1 (amber, where the white letter was barely visible) to
// 4.5:1 (indigo), so a project's color decided how loud it was in the list. Holding every
// swatch to one contrast band makes the color identifying rather than ranking.
//
// Retune with the contrast band, not by eye — a hue nudged for looks quietly re-weights that
// project against the other nine.
//
// Order is load-bearing: `deriveIdentityColorName` indexes into this array, so reordering
// silently recolors every existing project icon.
export const IDENTITY_COLOR_NAMES = [
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "red",
  "amber",
  "blue",
] as const;

export type IdentityColorName = (typeof IDENTITY_COLOR_NAMES)[number];

const IDENTITY_COLORS: Record<IdentityColorName, string> = {
  violet: "#7a6aa8",
  sky: "#3d7ea6",
  emerald: "#388068",
  orange: "#a4673a",
  pink: "#b05c80",
  indigo: "#6a70b8",
  teal: "#368080",
  red: "#b06260",
  amber: "#8f7838",
  blue: "#5179b0",
};

export function identityColor(name: IdentityColorName): string {
  return IDENTITY_COLORS[name];
}

function hashIdentityKey(key: string): number {
  let hash = 0;
  for (const character of key) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function deriveIdentityColorName(key: string): IdentityColorName {
  return IDENTITY_COLOR_NAMES[hashIdentityKey(key) % IDENTITY_COLOR_NAMES.length];
}
