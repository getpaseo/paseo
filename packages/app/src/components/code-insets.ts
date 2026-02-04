export function getCodeInsets(theme: any) {
  const paddingX = theme.spacing[3] + theme.spacing[2];
  const paddingY = theme.spacing[1];
  const extraRight = theme.spacing[4];
  const extraBottom = theme.spacing[3];

  return { paddingX, paddingY, extraRight, extraBottom };
}

