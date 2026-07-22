import { baseColors, PROJECT_ICON_COLORS } from "@/styles/theme";

const DARK_TEXT_THRESHOLD = 160_000;

function hashProjectKey(projectKey: string): number {
  let hash = 0;
  for (const character of projectKey) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function deriveProjectIconColor(projectKey: string): string {
  return PROJECT_ICON_COLORS[hashProjectKey(projectKey) % PROJECT_ICON_COLORS.length];
}

export function projectIconTextColor(backgroundColor: string): string {
  const value = backgroundColor.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return baseColors.white;

  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  const luminance = red * 299 + green * 587 + blue * 114;
  return luminance > DARK_TEXT_THRESHOLD ? baseColors.black : baseColors.white;
}
