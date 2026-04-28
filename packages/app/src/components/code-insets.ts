/**
 * Compute the pixel width for a line-number gutter based on the highest
 * line number that will be displayed. Minimum width accommodates 2 digits.
 */
export function lineNumberGutterWidth(maxLineNumber: number): number {
  const digits = Math.max(2, String(maxLineNumber).length);
  return digits * 8 + 12;
}

export function getCodeInsets(theme: any) {
  const padding =
    typeof theme.spacing?.[3] === "number"
      ? theme.spacing[3]
      : typeof theme.spacing?.[4] === "number"
        ? theme.spacing[4]
        : 12;
  const extraRight = theme.spacing[4];
  const extraBottom = theme.spacing[3];

  return { padding, extraRight, extraBottom };
}
