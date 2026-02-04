export function getCodeInsets(theme: any) {
  const currentHorizontal = theme.spacing[3] + theme.spacing[2];
  const padding =
    typeof theme.spacing?.[4] === "number" ? theme.spacing[4] : currentHorizontal;
  const extraRight = theme.spacing[4];
  const extraBottom = theme.spacing[3];

  return { padding, extraRight, extraBottom };
}
