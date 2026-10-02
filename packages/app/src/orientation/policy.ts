export type AndroidOrientationPolicy = "portrait" | "system";

// Screen size owns the Android orientation allowance. Pane layout still uses
// the available window width, including in split and floating windows.
export function resolveAndroidOrientationPolicy(screen: {
  width: number;
  height: number;
}): AndroidOrientationPolicy {
  return Math.min(screen.width, screen.height) >= 600 ? "system" : "portrait";
}
