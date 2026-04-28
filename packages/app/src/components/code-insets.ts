import type { Theme } from "@/styles/theme";

/**
 * Compute the pixel width for a line-number gutter based on the highest
 * line number that will be displayed and the gutter font size. Minimum
 * width accommodates 2 digits. The 0.62 factor approximates monospace
 * digit width as a fraction of font size.
 */
export function lineNumberGutterWidth(maxLineNumber: number, fontSize: number): number {
  const digits = Math.max(2, String(maxLineNumber).length);
  const digitWidth = Math.ceil(fontSize * 0.62);
  return digits * digitWidth + 12;
}

export function getCodeInsets(theme: Theme) {
  let padding: number;
  if (typeof theme.spacing?.[3] === "number") padding = theme.spacing[3];
  else if (typeof theme.spacing?.[4] === "number") padding = theme.spacing[4];
  else padding = 12;
  const extraRight = theme.spacing[4];
  const extraBottom = theme.spacing[3];

  return { padding, extraRight, extraBottom };
}
