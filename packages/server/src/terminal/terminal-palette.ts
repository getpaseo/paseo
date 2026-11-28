import type { TerminalDefaultColors } from "@getpaseo/protocol/messages";

export interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export type TerminalColorScheme = "dark" | "light";
export type TerminalOscColorCode = 10 | 11 | 12;

export interface ResolvedTerminalPalette {
  readonly foreground: RgbColor;
  readonly background: RgbColor;
  readonly cursor: RgbColor;
  readonly oscResponses: ReadonlyMap<TerminalOscColorCode, string>;
  readonly colorScheme: TerminalColorScheme;
  readonly colorFgBg: "15;0" | "0;15";
}

const DEFAULT_TERMINAL_BACKGROUND: RgbColor = { red: 0x0b, green: 0x0b, blue: 0x0b };
const DEFAULT_TERMINAL_FOREGROUND: RgbColor = { red: 0xe6, green: 0xe6, blue: 0xe6 };

function parseHexColor(value: string | undefined): { color: RgbColor; alpha: number } | undefined {
  const hex = value?.trim().replace(/^#/, "").toLowerCase();
  if (!hex || ![3, 4, 6, 8].includes(hex.length) || !/^[0-9a-f]+$/.test(hex)) {
    return undefined;
  }

  const rgb =
    hex.length <= 4
      ? hex.slice(0, 3).replaceAll(/./g, (channel) => channel + channel)
      : hex.slice(0, 6);
  let alpha = 0xff;
  if (hex.length === 4) {
    alpha = Number.parseInt(hex[3]!.repeat(2), 16);
  } else if (hex.length === 8) {
    alpha = Number.parseInt(hex.slice(6), 16);
  }

  return {
    color: {
      red: Number.parseInt(rgb.slice(0, 2), 16),
      green: Number.parseInt(rgb.slice(2, 4), 16),
      blue: Number.parseInt(rgb.slice(4, 6), 16),
    },
    alpha,
  };
}

function compositeColor(
  foreground: { color: RgbColor; alpha: number },
  background: RgbColor,
): RgbColor {
  if (foreground.alpha === 0xff) {
    return foreground.color;
  }

  const opacity = foreground.alpha / 0xff;
  return {
    red: Math.round(background.red + (foreground.color.red - background.red) * opacity),
    green: Math.round(background.green + (foreground.color.green - background.green) * opacity),
    blue: Math.round(background.blue + (foreground.color.blue - background.blue) * opacity),
  };
}

function resolveColor(
  value: string | undefined,
  fallback: RgbColor,
  background: RgbColor,
): RgbColor {
  const parsed = parseHexColor(value);
  return parsed ? compositeColor(parsed, background) : fallback;
}

function toOscColor(color: RgbColor): string {
  const channel = (value: number): string => value.toString(16).padStart(2, "0").repeat(2);
  return `rgb:${channel(color.red)}/${channel(color.green)}/${channel(color.blue)}`;
}

function deriveColorScheme(background: RgbColor): TerminalColorScheme {
  // Rec. 709 perceived luminance normalized to [0, 1].
  const luma =
    (0.2126 * background.red + 0.7152 * background.green + 0.0722 * background.blue) / 255;
  return luma >= 0.5 ? "light" : "dark";
}

function rgbEquals(left: RgbColor, right: RgbColor): boolean {
  return left.red === right.red && left.green === right.green && left.blue === right.blue;
}

export function resolveTerminalPalette(
  defaultColors?: TerminalDefaultColors,
): ResolvedTerminalPalette {
  // OSC RGB responses cannot carry alpha. xterm blends the foreground and cursor over the
  // terminal background; use the existing dark fallback as the backdrop for a translucent
  // background because the protocol does not carry another compositing surface.
  const background = resolveColor(
    defaultColors?.background,
    DEFAULT_TERMINAL_BACKGROUND,
    DEFAULT_TERMINAL_BACKGROUND,
  );
  const foreground = resolveColor(
    defaultColors?.foreground,
    DEFAULT_TERMINAL_FOREGROUND,
    background,
  );
  const cursor = resolveColor(
    defaultColors?.cursor ?? defaultColors?.foreground,
    foreground,
    background,
  );
  const colorScheme = deriveColorScheme(background);

  return {
    foreground,
    background,
    cursor,
    oscResponses: new Map<TerminalOscColorCode, string>([
      [10, toOscColor(foreground)],
      [11, toOscColor(background)],
      [12, toOscColor(cursor)],
    ]),
    colorScheme,
    colorFgBg: colorScheme === "light" ? "0;15" : "15;0",
  };
}

export function terminalPalettesEqual(
  left: ResolvedTerminalPalette,
  right: ResolvedTerminalPalette,
): boolean {
  return (
    rgbEquals(left.foreground, right.foreground) &&
    rgbEquals(left.background, right.background) &&
    rgbEquals(left.cursor, right.cursor)
  );
}

export function formatColorSchemeReport(colorScheme: TerminalColorScheme): string {
  return colorScheme === "light" ? "\x1b[?997;2n" : "\x1b[?997;1n";
}

export function formatColorSchemeModeReport(enabled: boolean): string {
  return `\x1b[?2031;${enabled ? 1 : 2}$y`;
}
