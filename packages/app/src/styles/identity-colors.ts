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

// The same ten identities used as *foreground* — a glyph or a label painted directly on the
// row — rather than as a fill with a white letter on top. That is a different contrast
// problem and the fill table cannot solve it: clearing 4.5:1 against a near-white surface
// needs luminance <= 0.183, and against the dark sidebar it needs >= 0.212, so no single hex
// serves both. Hence one set per scheme. The hue is what identifies a host, and the hue is
// unchanged from IDENTITY_COLORS above; only lightness moves.
//
// The geometry is deliberately the status family's, not a band of its own: same lightness,
// same chroma fraction as statusSuccess and friends in theme.ts. A sidebar meta row puts a
// host badge next to a CI check and a diff stat, and if the two families sit at different
// lightness the louder one wins an argument it should not be having — the fill table's
// L=0.571 against status dark's L=0.700 is exactly why a passing check used to shout over a
// host name. Anything that changes the status band has to change this one with it.
const IDENTITY_FOREGROUND_LIGHT: Record<IdentityColorName, string> = {
  // L=0.50, chroma 60% of gamut max — 5.3:1 to 5.8:1 on the light sidebar
  violet: "#6d49b5",
  sky: "#3d6985",
  emerald: "#3e6e5d",
  orange: "#845838",
  pink: "#974168",
  indigo: "#5251c2",
  teal: "#3e6d6c",
  red: "#9c4243",
  amber: "#716239",
  blue: "#39649e",
};

const IDENTITY_FOREGROUND_DARK: Record<IdentityColorName, string> = {
  // L=0.70, chroma 55% of gamut max — 6.3:1 to 7.2:1 on the dark sidebar
  violet: "#a392d5",
  sky: "#6aa6ce",
  emerald: "#6cae96",
  orange: "#cc8f64",
  pink: "#d87da3",
  indigo: "#9299d5",
  teal: "#6cacab",
  red: "#d88381",
  amber: "#b29d64",
  blue: "#7ba1d5",
};

export function identityForeground(name: IdentityColorName, colorScheme: "light" | "dark"): string {
  return colorScheme === "light" ? IDENTITY_FOREGROUND_LIGHT[name] : IDENTITY_FOREGROUND_DARK[name];
}

/** The same hue at 10% alpha, for fills that sit behind text of the full-strength color. */
export function identityTint(name: IdentityColorName): string {
  return `${IDENTITY_COLORS[name]}1a`;
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
