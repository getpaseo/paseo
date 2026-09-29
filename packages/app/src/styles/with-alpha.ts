function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) return null;
  return [match[1]!, match[2]!, match[3]!].map((part) => Number.parseInt(part, 16)) as [
    number,
    number,
    number,
  ];
}

/**
 * `color` laid over `background` at `amount`, as an opaque hex. Web styles here drop the alpha
 * of rgba() and 8-digit hex, so a tint has to be mixed into a solid color.
 */
export function tintOver(color: string, background: string, amount: number): string {
  const top = parseHex(color);
  const base = parseHex(background);
  if (!top || !base) return color;
  const mixed = top.map((channel, index) =>
    Math.round(channel * amount + base[index]! * (1 - amount)),
  );
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A selection tint: on web the theme colors are CSS variables, so the browser mixes them;
 * native gets real hex values and mixes here.
 */
export function selectionTint(input: { accent: string; surface: string; isWeb: boolean }): string {
  return input.isWeb
    ? `color-mix(in srgb, ${input.accent} 18%, ${input.surface})`
    : tintOver(input.accent, input.surface, 0.18);
}
