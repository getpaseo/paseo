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
