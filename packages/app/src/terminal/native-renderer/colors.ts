import type { ITheme } from "@xterm/xterm";
import type { TerminalCell } from "@getpaseo/protocol/messages";
import { PASEO_TERMINAL_STYLE_FLAGS } from "../../../modules/paseo-terminal/contract";

import { darkTheme } from "@/styles/theme";
import { toXtermTheme } from "@/utils/to-xterm-theme";

const ANSI_THEME_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const CUBE_LEVELS = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff] as const;
const DEFAULT_COLOR_MODE = 0;
const ANSI_COLOR_MODE = 1;
const INDEXED_COLOR_MODE = 2;
const RGB_COLOR_MODE = 3;
const OPAQUE_BLACK = 0xff000000;
const DIM_ALPHA = 0.65;

/** Colors are unsigned ARGB. A background of 0 is the terminal background. */
export interface ResolvedCellStyle {
  foreground: number;
  background: number;
  flags: number;
}

export interface TerminalCellStyleResolver {
  readonly backgroundColor: number;
  readonly cursorColor: number;
  resolve(cell: TerminalCell): ResolvedCellStyle;
}

export const DEFAULT_TERMINAL_THEME = toXtermTheme(darkTheme.colors.terminal);

export const NATIVE_TERMINAL_SELECTION_COLORS = {
  background: 0xffffff00,
  foreground: 0xff000000,
} as const;

function build256Palette(theme: ITheme): number[] {
  const palette = Array.from({ length: 256 }, () => OPAQUE_BLACK);

  for (let index = 0; index < ANSI_THEME_KEYS.length; index += 1) {
    const key = ANSI_THEME_KEYS[index];
    palette[index] = parseTerminalColor(theme[key] ?? DEFAULT_TERMINAL_THEME[key], OPAQUE_BLACK);
  }

  for (let red = 0; red < CUBE_LEVELS.length; red += 1) {
    for (let green = 0; green < CUBE_LEVELS.length; green += 1) {
      for (let blue = 0; blue < CUBE_LEVELS.length; blue += 1) {
        const index = 16 + red * 36 + green * 6 + blue;
        palette[index] = rgbColor(
          (CUBE_LEVELS[red] << 16) | (CUBE_LEVELS[green] << 8) | CUBE_LEVELS[blue],
        );
      }
    }
  }

  for (let index = 0; index < 24; index += 1) {
    const value = 8 + index * 10;
    palette[232 + index] = rgbColor((value << 16) | (value << 8) | value);
  }

  return palette;
}

function rgbColor(value: number): number {
  return (OPAQUE_BLACK | (value & 0xffffff)) >>> 0;
}

function argb(input: { alpha: number; red: number; green: number; blue: number }): number {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return (
    ((channel(input.alpha) << 24) |
      (channel(input.red) << 16) |
      (channel(input.green) << 8) |
      channel(input.blue)) >>>
    0
  );
}

/** Parses the CSS color forms terminal themes use: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`. */
export function parseTerminalColor(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const color = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(color)?.[1];
  if (hex) {
    const digits = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const channel = (offset: number) => Number.parseInt(digits.slice(offset, offset + 2), 16);
    return argb({
      alpha: digits.length === 8 ? channel(6) : 255,
      red: channel(0),
      green: channel(2),
      blue: channel(4),
    });
  }
  const functional = /^rgba?\(([^)]*)\)$/.exec(color)?.[1];
  if (functional) {
    const parts = functional
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.every((part) => Number.isFinite(part))) {
      return argb({
        alpha: parts.length >= 4 ? parts[3] * 255 : 255,
        red: parts[0],
        green: parts[1],
        blue: parts[2],
      });
    }
  }
  return fallback;
}

function withDimAlpha(color: number): number {
  const alpha = (color >>> 24) & 0xff;
  return (((Math.round(alpha * DIM_ALPHA) & 0xff) << 24) | (color & 0xffffff)) >>> 0;
}

function resolveColor(input: {
  value: number | undefined;
  mode: number | undefined;
  fallback: number;
  palette: number[];
}): number {
  const mode = input.mode ?? DEFAULT_COLOR_MODE;
  const value = input.value ?? 0;

  if (mode === ANSI_COLOR_MODE || mode === INDEXED_COLOR_MODE) {
    return input.palette[value] ?? input.fallback;
  }
  if (mode === RGB_COLOR_MODE) {
    return rgbColor(value);
  }
  return input.fallback;
}

function cellFlags(cell: TerminalCell): number {
  let flags = 0;
  if (cell.bold) flags |= PASEO_TERMINAL_STYLE_FLAGS.bold;
  if (cell.italic) flags |= PASEO_TERMINAL_STYLE_FLAGS.italic;
  if (cell.underline) flags |= PASEO_TERMINAL_STYLE_FLAGS.underline;
  if (cell.strikethrough) flags |= PASEO_TERMINAL_STYLE_FLAGS.strikethrough;
  if (cell.dim) flags |= PASEO_TERMINAL_STYLE_FLAGS.dim;
  return flags;
}

export function createTerminalCellStyleResolver(theme: ITheme): TerminalCellStyleResolver {
  const palette = build256Palette(theme);
  const foregroundColor = parseTerminalColor(
    theme.foreground ?? DEFAULT_TERMINAL_THEME.foreground,
    0xfffafafa,
  );
  const backgroundColor = parseTerminalColor(
    theme.background ?? DEFAULT_TERMINAL_THEME.background,
    0xff181b1a,
  );
  const cursorColor = parseTerminalColor(theme.cursor, foregroundColor);

  return {
    backgroundColor,
    cursorColor,
    resolve(cell: TerminalCell): ResolvedCellStyle {
      const foreground = resolveColor({
        value: cell.fg,
        mode: cell.fgMode,
        fallback: foregroundColor,
        palette,
      });
      const background = resolveColor({
        value: cell.bg,
        mode: cell.bgMode,
        fallback: backgroundColor,
        palette,
      });
      const resolvedForeground = cell.inverse ? background : foreground;
      const resolvedBackground = cell.inverse ? foreground : background;
      const flags = cellFlags(cell);
      return {
        foreground: cell.dim ? withDimAlpha(resolvedForeground) : resolvedForeground,
        background: resolvedBackground === backgroundColor ? 0 : resolvedBackground,
        flags,
      };
    },
  };
}
