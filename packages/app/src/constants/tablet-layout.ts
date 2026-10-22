import { createContext } from "react";

export type TabletLayout = "desktop" | "phone";
export const TabletLayoutContext = createContext({
  landscape: "desktop" as TabletLayout,
  portrait: "phone" as TabletLayout,
});

export function isTabletLayoutWindow(input: {
  width: number;
  height: number;
  screenWidth?: number;
  screenHeight?: number;
}): boolean {
  return (
    Math.min(input.screenWidth ?? input.width, input.screenHeight ?? input.height) >= 600 &&
    input.width >= 600
  );
}

export function resolveCompactLayout(input: {
  compactBreakpoint: boolean;
  android: boolean;
  width: number;
  height: number;
  landscape: TabletLayout;
  portrait: TabletLayout;
  screenWidth?: number;
  screenHeight?: number;
}): boolean {
  if (!input.android || !isTabletLayoutWindow(input)) {
    return input.compactBreakpoint;
  }
  return (
    ((input.screenWidth ?? input.width) >= (input.screenHeight ?? input.height)
      ? input.landscape
      : input.portrait) === "phone"
  );
}
