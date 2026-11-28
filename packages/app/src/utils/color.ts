/**
 * Colour maths in OKLab, for the cases where a colour has to be adjusted rather than chosen.
 *
 * OKLab because chroma and lightness are separable there in a way they are not in HSL: scaling
 * HSL saturation drags perceived brightness with it, so a set of icons desaturated that way ends
 * up with the yellows washed out and the blues barely touched. In OKLab, holding L fixed and
 * scaling the a/b vector moves a colour straight toward grey at the same apparent lightness.
 *
 * Reducing chroma always stays inside sRGB — the gamut is convex around the neutral axis — so
 * these conversions never need gamut mapping.
 */

interface Oklab {
  L: number;
  a: number;
  b: number;
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function linearRgbToOklab(r: number, g: number, b: number): Oklab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToLinearRgb({ L, a, b }: Oklab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Parses `#rgb` and `#rrggbb` into 0–1 sRGB channels. Anything else is not a colour we own. */
export function parseHexColor(hex: string): [number, number, number] | null {
  const body = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]+$/.test(body)) return null;

  let expanded: string;
  if (body.length === 3) {
    expanded = `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  } else if (body.length === 6) {
    expanded = body;
  } else {
    return null;
  }

  return [
    Number.parseInt(expanded.slice(0, 2), 16) / 255,
    Number.parseInt(expanded.slice(2, 4), 16) / 255,
    Number.parseInt(expanded.slice(4, 6), 16) / 255,
  ];
}

/** Adds alpha to a theme-owned hex color in a format accepted by Canvas and Skia. */
export function hexColorWithAlpha(hex: string, alpha: number): string {
  const rgb = parseHexColor(hex);
  if (!rgb) throw new TypeError(`Expected a hex color, received ${hex}`);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new RangeError(`Color alpha must be between 0 and 1, received ${alpha}`);
  }
  const [r, g, b] = rgb.map((channel) => Math.round(channel * 255));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function toHexChannel(channel: number): string {
  const clamped = Math.min(255, Math.max(0, Math.round(channel * 255)));
  return clamped.toString(16).padStart(2, "0");
}

/**
 * Scales a colour's chroma toward neutral while holding its perceived lightness.
 *
 * `amount` is the fraction of the original chroma to keep: `1` is unchanged, `0` is grey. Input
 * that is not a hex colour comes back untouched, so this is safe to run over strings that mix
 * colours with things like `none` or `currentColor`.
 */
export function desaturateHexColor(hex: string, amount: number): string {
  const rgb = parseHexColor(hex);
  if (!rgb) return hex;

  const [r, g, b] = rgb;
  const lab = linearRgbToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
  const [linearR, linearG, linearB] = oklabToLinearRgb({
    L: lab.L,
    a: lab.a * amount,
    b: lab.b * amount,
  });

  return `#${toHexChannel(linearToSrgb(linearR))}${toHexChannel(linearToSrgb(linearG))}${toHexChannel(linearToSrgb(linearB))}`;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

// Derivation compares opaque colors. `#rgba` and `#rrggbbaa` are valid theme input, so their alpha
// channel is dropped here and the colour is read as the opaque one it sits on.
function withoutAlpha(hex: string): string {
  if (/^#[0-9a-fA-F]{4}$/.test(hex)) return hex.slice(0, 4);
  if (/^#[0-9a-fA-F]{8}$/.test(hex)) return hex.slice(0, 7);
  return hex;
}

function requireRgb(hex: string): [number, number, number] {
  const rgb = parseHexColor(withoutAlpha(hex));
  if (!rgb) throw new TypeError(`Expected a hex color, received ${hex}`);
  return rgb;
}

/** WCAG contrast ratio between two hex colours, from 1 (identical) to 21. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(requireRgb(a));
  const second = relativeLuminance(requireRgb(b));
  const [lighter, darker] = first >= second ? [first, second] : [second, first];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Moves `hex` toward `toward` until it sits at `ratio` WCAG contrast from where it started.
 *
 * A step is expressed as a contrast ratio rather than a lightness delta because a lightness step
 * vanishes near black: the same OKLab delta that is obvious on mid grey changes nothing visible
 * on `#000000`, while a contrast step stays equally visible on every base. The move is a blend in
 * linear light, so hue stays with the base. A ratio the target cannot reach stops at the target.
 */
export function stepContrast(hex: string, toward: string, ratio: number): string {
  const from = requireRgb(hex);
  const goal = requireRgb(toward);
  const fromLuminance = relativeLuminance(from);
  const goalLuminance = relativeLuminance(goal);
  if (goalLuminance === fromLuminance) return hex;
  const lighter = goalLuminance > fromLuminance;
  const targetLuminance = lighter
    ? ratio * (fromLuminance + 0.05) - 0.05
    : (fromLuminance + 0.05) / ratio - 0.05;
  const reach = (targetLuminance - fromLuminance) / (goalLuminance - fromLuminance);
  const amount = Math.min(1, Math.max(0, reach));
  const channels = from.map((channel, index) => {
    const start = srgbToLinear(channel);
    const end = srgbToLinear(goal[index]);
    return toHexChannel(linearToSrgb(start + (end - start) * amount));
  });
  return `#${channels.join("")}`;
}

/** Blends `hex` toward `toward` by `amount` (0 keeps `hex`, 1 is `toward`) in sRGB. */
export function mixHexColors(hex: string, toward: string, amount: number): string {
  const from = requireRgb(hex);
  const goal = requireRgb(toward);
  const channels = from.map((channel, index) =>
    toHexChannel(channel + (goal[index] - channel) * amount),
  );
  return `#${channels.join("")}`;
}
