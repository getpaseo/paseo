import type { ITheme } from "@xterm/xterm";
import type { TextStyle } from "react-native";
import type { TerminalCell } from "@getpaseo/protocol/messages";

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
const FLAG_BOLD = 1 << 0;
const FLAG_ITALIC = 1 << 1;
const FLAG_UNDERLINE = 1 << 2;
const FLAG_DIM = 1 << 3;
const FLAG_INVERSE = 1 << 4;
const FLAG_STRIKETHROUGH = 1 << 5;

interface ResolvedCellStyle {
  key: string;
  style: TextStyle;
}

interface ResolvedCellColors {
  foreground: string;
  background: string;
  paintsBackground: boolean;
}

export interface TerminalCellStyleResolver {
  readonly themeKey: string;
  readonly backgroundColor: string;
  readonly cursorColor: string;
  resolve(cell: TerminalCell): ResolvedCellStyle;
}

export const DEFAULT_TERMINAL_THEME = toXtermTheme(darkTheme.colors.terminal);

function build256Palette(theme: ITheme): string[] {
  const palette = Array.from({ length: 256 }, () => "");

  for (let index = 0; index < ANSI_THEME_KEYS.length; index += 1) {
    const key = ANSI_THEME_KEYS[index];
    palette[index] = theme[key] ?? DEFAULT_TERMINAL_THEME[key] ?? "#000000";
  }

  for (let red = 0; red < CUBE_LEVELS.length; red += 1) {
    for (let green = 0; green < CUBE_LEVELS.length; green += 1) {
      for (let blue = 0; blue < CUBE_LEVELS.length; blue += 1) {
        const index = 16 + red * 36 + green * 6 + blue;
        palette[index] = `rgb(${CUBE_LEVELS[red]}, ${CUBE_LEVELS[green]}, ${CUBE_LEVELS[blue]})`;
      }
    }
  }

  for (let index = 0; index < 24; index += 1) {
    const value = 8 + index * 10;
    palette[232 + index] = `rgb(${value}, ${value}, ${value})`;
  }

  return palette;
}

function rgbColor(value: number): string {
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `rgb(${red}, ${green}, ${blue})`;
}

function resolveColor(input: {
  value: number | undefined;
  mode: number | undefined;
  fallback: string;
  palette: string[];
}): string {
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
  if (cell.bold) flags |= FLAG_BOLD;
  if (cell.italic) flags |= FLAG_ITALIC;
  if (cell.underline) flags |= FLAG_UNDERLINE;
  if (cell.dim) flags |= FLAG_DIM;
  if (cell.inverse) flags |= FLAG_INVERSE;
  if (cell.strikethrough) flags |= FLAG_STRIKETHROUGH;
  return flags;
}

function resolveCellColors(input: {
  cell: TerminalCell;
  palette: string[];
  foregroundColor: string;
  backgroundColor: string;
}): ResolvedCellColors {
  const foreground = resolveColor({
    value: input.cell.fg,
    mode: input.cell.fgMode,
    fallback: input.foregroundColor,
    palette: input.palette,
  });
  const background = resolveColor({
    value: input.cell.bg,
    mode: input.cell.bgMode,
    fallback: input.backgroundColor,
    palette: input.palette,
  });

  const resolvedForeground = input.cell.inverse ? background : foreground;
  const resolvedBackground = input.cell.inverse ? foreground : background;
  return {
    foreground: resolvedForeground,
    background: resolvedBackground,
    paintsBackground: resolvedBackground !== input.backgroundColor,
  };
}

function textDecorationLine(flags: number): TextStyle["textDecorationLine"] | undefined {
  const underline = (flags & FLAG_UNDERLINE) !== 0;
  const strikethrough = (flags & FLAG_STRIKETHROUGH) !== 0;
  if (underline && strikethrough) return "underline line-through";
  if (underline) return "underline";
  if (strikethrough) return "line-through";
  return undefined;
}

function createTextStyle(input: {
  foreground: string;
  background: string;
  paintsBackground: boolean;
  flags: number;
}): TextStyle {
  const style: TextStyle = {
    color: input.foreground,
  };

  if (input.paintsBackground) {
    style.backgroundColor = input.background;
  }
  if ((input.flags & FLAG_BOLD) !== 0) {
    style.fontWeight = "700";
  }
  if ((input.flags & FLAG_ITALIC) !== 0) {
    style.fontStyle = "italic";
  }
  if ((input.flags & FLAG_DIM) !== 0) {
    style.opacity = 0.65;
  }

  const decorationLine = textDecorationLine(input.flags);
  if (decorationLine) {
    style.textDecorationLine = decorationLine;
    style.textDecorationColor = input.foreground;
  }

  return style;
}

function buildStyleKey(input: {
  foreground: string;
  background: string;
  paintsBackground: boolean;
  flags: number;
}): string {
  const background = input.paintsBackground ? input.background : "default";
  return `${input.foreground}|${background}|${input.flags}`;
}

function buildThemeKey(theme: ITheme): string {
  return JSON.stringify(theme);
}

export function createTerminalCellStyleResolver(theme: ITheme): TerminalCellStyleResolver {
  const palette = build256Palette(theme);
  const foregroundColor = theme.foreground ?? DEFAULT_TERMINAL_THEME.foreground ?? "#fafafa";
  const backgroundColor = theme.background ?? DEFAULT_TERMINAL_THEME.background ?? "#181B1A";
  const cursorColor = theme.cursor ?? foregroundColor;
  const styleCache = new Map<string, TextStyle>();

  return {
    themeKey: buildThemeKey(theme),
    backgroundColor,
    cursorColor,
    resolve(cell: TerminalCell): ResolvedCellStyle {
      const flags = cellFlags(cell);
      const colors = resolveCellColors({ cell, palette, foregroundColor, backgroundColor });
      const key = buildStyleKey({
        foreground: colors.foreground,
        background: colors.background,
        paintsBackground: colors.paintsBackground,
        flags,
      });
      const cachedStyle = styleCache.get(key);
      if (cachedStyle) {
        return { key, style: cachedStyle };
      }

      const style = createTextStyle({
        foreground: colors.foreground,
        background: colors.background,
        paintsBackground: colors.paintsBackground,
        flags,
      });
      styleCache.set(key, style);
      return { key, style };
    },
  };
}
