import { createElement, type ElementType } from "react";
import { lightHighlightColors } from "@getpaseo/highlight";
import { lightTheme } from "../src/styles/theme";

const pinnedTheme = {
  colorScheme: "light",
  colors: {
    syntax: lightHighlightColors,
    foreground: "#111111",
    foregroundMuted: "#666666",
    statusSuccess: "#15803d",
    statusDanger: "#b91c1c",
    statusWarning: "#d97706",
    statusMerged: "#7c3aed",
    // Same rule as the real theme: the status color at 12%.
    statusSuccessTint: "#15803d1f",
    statusDangerTint: "#b91c1c1f",
    statusWarningTint: "#d977061f",
    // The light band's values, so a test can name the colour it expects.
    statusDotSuccess: "#299f51",
    statusDotDanger: "#f12e2f",
    statusDotWarning: "#b37824",
    statusDotRunning: "#268ae0",
    accent: "#2563eb",
    accentForeground: "#ffffff",
    destructive: "#dc2626",
    destructiveForeground: "#ffffff",
    surface1: "#fafafa",
    surface2: "#f4f4f5",
    surface3: "#e4e4e7",
    surfaceSidebar: lightTheme.colors.surfaceSidebar,
    border: "#e4e4e7",
    borderAccent: "#a1a1aa",
    palette: {
      amber: { 500: "#f59e0b" },
      blue: { 300: "#93c5fd", 400: "#60a5fa" },
      green: { 400: "#4ade80", 500: "#22c55e" },
      yellow: { 400: "#facc15" },
      zinc: { 600: "#52525b" },
      red: { 300: "#fca5a5" },
      white: "#ffffff",
    },
  },
  borderWidth: { 1: 1 },
  spacing: [0, 4, 8, 12, 16, 20, 24, 28, 32],
  fontSize: {
    xs: 12,
    sm: 14,
    base: 16,
  },
  fontFamily: {
    ui: "sans-serif",
    mono: "monospace",
  },
  fontWeight: {
    normal: "400",
    medium: "500",
  },
  borderRadius: {
    base: 4,
    md: 6,
    lg: 8,
    xl: 12,
    full: 9999,
  },
  iconSize: { sm: 16, md: 20 },
  opacity: { 50: 0.5 },
  shadow: {
    sm: {
      shadowColor: "rgba(0, 0, 0, 0.02)",
      shadowOffset: { width: 0, height: 2 },
      shadowRadius: 8,
      elevation: 2,
    },
    md: {
      shadowColor: "rgba(0, 0, 0, 0.04)",
      shadowOffset: { width: 0, height: 4 },
      shadowRadius: 16,
      elevation: 4,
    },
    lg: {
      shadowColor: "rgba(0, 0, 0, 0.08)",
      shadowOffset: { width: 0, height: 8 },
      shadowRadius: 24,
      elevation: 8,
    },
  },
};

// Tokens a test does not pin come from the real light theme, so a style or `uniProps` mapping
// that reads one (the markdown renderer reads `colors.terminal`) gets a value instead of crashing.
const testTheme = {
  ...lightTheme,
  ...pinnedTheme,
  colors: { ...lightTheme.colors, ...pinnedTheme.colors },
};

type StyleFactory<T> = (theme: typeof testTheme) => T;

function isStyleFactory<T>(styles: T | StyleFactory<T>): styles is StyleFactory<T> {
  return typeof styles === "function";
}

// The app's breakpoints (src/styles/unistyles.ts), widest first.
const BREAKPOINTS: [string, number][] = [
  ["xl", 1200],
  ["lg", 992],
  ["md", 600],
  ["sm", 576],
  ["xs", 0],
];
const BREAKPOINT_NAMES = new Set(BREAKPOINTS.map(([name]) => name));

function isBreakpointValue(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => BREAKPOINT_NAMES.has(key));
}

/** Picks a breakpoint value for the window's width, the way Unistyles does at runtime. */
function resolveBreakpointValue(value: Record<string, unknown>): unknown {
  const width = typeof window === "undefined" ? 0 : window.innerWidth;
  for (const [name, minWidth] of BREAKPOINTS) {
    if (width >= minWidth && name in value) return value[name];
  }
  return undefined;
}

function resolveStyle(style: unknown): unknown {
  if (typeof style === "function") {
    return (...args: unknown[]) => resolveStyle(style(...args));
  }
  if (typeof style !== "object" || style === null || Array.isArray(style)) return style;
  return Object.fromEntries(
    Object.entries(style).map(([key, value]) => [
      key,
      isBreakpointValue(value) ? resolveBreakpointValue(value) : value,
    ]),
  );
}

function resolveStyles<T>(styles: T): T {
  if (typeof styles !== "object" || styles === null) return styles;
  return Object.fromEntries(
    Object.entries(styles).map(([name, style]) => [name, resolveStyle(style)]),
  ) as T;
}

export const StyleSheet = {
  create: <T>(styles: T | StyleFactory<T>): T =>
    resolveStyles(isStyleFactory(styles) ? styles(testTheme) : styles),
};

type UniPropsMapping = (theme: typeof testTheme, runtime: object) => Record<string, unknown>;

/** Applies `uniProps` with the test theme, the way Unistyles maps theme values onto props. */
export const withUnistyles = <T>(Component: T): T => {
  function ThemedComponent({ uniProps, ...props }: { uniProps?: UniPropsMapping }) {
    // Explicit props win over mapped ones, as in Unistyles' `deepMergeObjects(mappings, uniProps, props)`.
    return createElement(Component as ElementType, {
      ...(uniProps ? uniProps(testTheme, {}) : {}),
      ...props,
    });
  }
  return ThemedComponent as T;
};

export const useUnistyles = () => ({
  theme: testTheme,
  rt: {},
  breakpoint: undefined,
});

export const UnistylesRuntime = {
  setTheme: () => undefined,
  themeName: "light",
};
