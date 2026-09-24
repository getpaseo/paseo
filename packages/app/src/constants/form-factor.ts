// Android's sw600dp large-screen baseline. Android 16 frees apps at this width;
// older releases still pillarbox them.
export const LARGE_SCREEN_MIN_SHORTEST_SIDE = 600;

export type OrientationPolicy = "follow-sensor" | "lock-portrait";

// Takes the physical screen, not the window: a tablet in a floating or split
// window is still a tablet here. Layout still keys off window width.
// Returns null off Android, where the Info.plist keys already do this.
export function resolveOrientationPolicy(args: {
  isAndroid: boolean;
  screenWidth: number;
  screenHeight: number;
}): OrientationPolicy | null {
  if (!args.isAndroid) {
    return null;
  }

  const shortestSide = Math.min(args.screenWidth, args.screenHeight);

  return shortestSide >= LARGE_SCREEN_MIN_SHORTEST_SIDE ? "follow-sensor" : "lock-portrait";
}
