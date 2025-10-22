export const theme = {
  colors: {
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
      900: "#18181b",
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
      500: "#22c55e",
      600: "#16a34a",
      800: "#166534",
      900: "#14532d",
    },

    // Red scale
    red: {
      100: "#fee2e2",
      200: "#fecaca",
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
  },

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
  },

  fontWeight: {
    normal: "normal" as const,
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

export type Theme = typeof theme;
