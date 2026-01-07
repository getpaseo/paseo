export const baseColors = {
  // Base colors
  white: "#ffffff",
  black: "#000000",

  // Zinc scale (primary gray palette)
  zinc: {
    50: "#fafafa",
    100: "#f4f4f5",
    200: "#e4e4e7",
    300: "#d4d4d8",
    400: "#a1a1aa",
    500: "#71717a",
    600: "#52525b",
    700: "#3f3f46",
    800: "#27272a",
    850: "#1a1a1d",
    900: "#18181b",
    950: "#121214",
  },

  // Gray scale
  gray: {
    50: "#f9fafb",
    100: "#f3f4f6",
    200: "#e5e7eb",
    300: "#d1d5db",
    400: "#9ca3af",
    500: "#6b7280",
    600: "#4b5563",
    700: "#374151",
    800: "#1f2937",
    900: "#111827",
  },

  // Slate scale
  slate: {
    200: "#e2e8f0",
  },

  // Blue scale
  blue: {
    50: "#eff6ff",
    100: "#dbeafe",
    200: "#bfdbfe",
    300: "#93c5fd",
    400: "#60a5fa",
    500: "#3b82f6",
    600: "#2563eb",
    700: "#1d4ed8",
    800: "#1e40af",
    900: "#1e3a8a",
    950: "#172554",
  },

  // Green scale
  green: {
    100: "#dcfce7",
    200: "#bbf7d0",
    400: "#4ade80",
    500: "#22c55e",
    600: "#16a34a",
    800: "#166534",
    900: "#14532d",
  },

  // Red scale
  red: {
    100: "#fee2e2",
    200: "#fecaca",
    300: "#fca5a5",
    500: "#ef4444",
    600: "#dc2626",
    800: "#991b1b",
    900: "#7f1d1d",
  },

  // Teal scale
  teal: {
    200: "#99f6e4",
  },

  // Amber scale
  amber: {
    500: "#f59e0b",
  },

  // Yellow scale
  yellow: {
    400: "#fbbf24",
  },

  // Purple scale
  purple: {
    500: "#a855f7",
    600: "#9333ea",
  },

  // Orange scale
  orange: {
    500: "#f97316",
    600: "#ea580c",
  },
} as const;

// Semantic color tokens (shadcn-style)
const lightSemanticColors = {
  background: "#ffffff",
  foreground: "#09090b",
  card: "#ffffff",
  cardForeground: "#09090b",
  popover: "#ffffff",
  popoverForeground: "#09090b",
  primary: "#18181b",
  primaryForeground: "#fafafa",
  secondary: "#f4f4f5",
  secondaryForeground: "#18181b",
  muted: "#f4f4f5",
  mutedForeground: "#71717a",
  accent: "#f4f4f5",
  accentForeground: "#18181b",
  destructive: "#ef4444",
  destructiveForeground: "#fafafa",
  border: "#e4e4e7",
  accentBorder: "#3f3f46",
  input: "#e4e4e7",
  ring: "#18181b",
} as const;

const darkSemanticColors = {
  background: "#09090b",
  foreground: "#fafafa",
  card: "#09090b",
  cardForeground: "#fafafa",
  popover: "#18181b",
  popoverForeground: "#fafafa",
  primary: "#fafafa",
  primaryForeground: "#18181b",
  secondary: "#27272a",
  secondaryForeground: "#fafafa",
  muted: "#27272a",
  mutedForeground: "#a1a1aa",
  accent: "#27272a",
  accentForeground: "#fafafa",
  destructive: "#7f1d1d",
  destructiveForeground: "#fafafa",
  border: "#27272e",
  accentBorder: "#414146",
  input: "#27272a",
  ring: "#d4d4d8",
} as const;

const commonTheme = {
  spacing: {
    0: 0,
    1: 4,
    2: 8,
    3: 12,
    4: 16,
    6: 24,
    8: 32,
    12: 48,
    16: 64,
    20: 80,
    24: 96,
    32: 128,
  },

  fontSize: {
    xs: 10,
    sm: 12,
    base: 14,
    lg: 16,
    xl: 18,
    "2xl": 20,
    "3xl": 24,
    "4xl": 32,
  },

  fontWeight: {
    normal: "normal" as const,
    medium: "500" as const,
    semibold: "600" as const,
    bold: "bold" as const,
  },

  borderRadius: {
    none: 0,
    sm: 2,
    base: 4,
    md: 6,
    lg: 8,
    xl: 12,
    "2xl": 16,
    full: 9999,
  },

  borderWidth: {
    0: 0,
    1: 1,
    2: 2,
  },

  opacity: {
    0: 0,
    50: 0.5,
    100: 1,
  },
} as const;

export const darkTheme = {
  colors: {
    ...darkSemanticColors,
    palette: baseColors,
  },
  ...commonTheme,
} as const;

export const lightTheme = {
  colors: {
    ...lightSemanticColors,
    palette: baseColors,
  },
  ...commonTheme,
} as const;

// Keep compatibility with existing code
export const theme = darkTheme;

// Export a union type that works for both themes
export type Theme = typeof darkTheme | typeof lightTheme;
