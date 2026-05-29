// Medium-saturation tones chosen so a white letter stays legible on top in both
// light and dark themes. Soft and colorful, but not pale pastels.
const PROJECT_ICON_COLORS = [
  "#8b5cf6", // violet
  "#0ea5e9", // sky
  "#10b981", // emerald
  "#f97316", // orange
  "#ec4899", // pink
  "#6366f1", // indigo
  "#14b8a6", // teal
  "#ef4444", // red
  "#eab308", // amber
  "#3b82f6", // blue
];

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
