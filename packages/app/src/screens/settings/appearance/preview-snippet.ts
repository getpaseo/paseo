export const PREVIEW_FILENAME = "preview.ts";

export const PREVIEW_BEFORE = [
  "const themePreview: ThemeConfig = {",
  '  surface: "sidebar",',
  '  accent: "#2563eb",',
  "  contrast: 42,",
  "};",
];

export const PREVIEW_AFTER = [
  "const themePreview: ThemeConfig = {",
  '  surface: "sidebar-elevated",',
  '  accent: "#0ea5e9",',
  "  contrast: 68,",
  "};",
];

export const CHANGED_LINE_INDICES: ReadonlySet<number> = new Set([1, 2, 3]);
