import { createContext, type ReactNode } from "react";
import { View } from "react-native";
import type { DesktopDivisionLayout } from "@/components/desktop-sidebar-layout";

// The app shell knows its allocation before nested native screen roots resize.
// Null keeps the existing measured layout on platforms without modern window layout.
export const AppContentWidthContext = createContext<number | null>(null);
export const AppContentLeadingOffsetContext = createContext<number | null>(null);

/** A native fold owns the split while active; saved sidebar widths remain unchanged. */
export const DesktopSidebarDivisionContext = createContext<DesktopDivisionLayout | null>(null);

interface AppContentWidthHandoff {
  allocatedWidth: number | null;
  pendingWidth: number | null;
}

/** Pin a new allocation until the native parent catches up, then yield to live layout. */
export function reconcileAppContentWidthHandoff(
  previous: AppContentWidthHandoff | undefined,
  allocatedWidth: number | null,
  nativeWidth: number,
): AppContentWidthHandoff {
  // Native layout events include subpixel rounding that the shell allocation does not.
  if (!previous || previous.allocatedWidth !== allocatedWidth) {
    const pendingWidth =
      allocatedWidth === null || Math.abs(allocatedWidth - nativeWidth) <= 0.5
        ? null
        : allocatedWidth;
    return { allocatedWidth, pendingWidth };
  }
  if (previous.pendingWidth !== null && Math.abs(nativeWidth - previous.pendingWidth) <= 0.5) {
    return { allocatedWidth, pendingWidth: null };
  }
  return previous;
}

const contentStyle = { flex: 1 } as const;

export function AppContentWidthFrame({
  width,
  viewportWidth,
  leadingInset,
  children,
}: {
  width: number | null;
  viewportWidth: number;
  leadingInset: number;
  children: ReactNode;
}) {
  const leadingOffset = Math.max(0, leadingInset + viewportWidth - (width ?? viewportWidth));
  return (
    <AppContentWidthContext value={width}>
      <AppContentLeadingOffsetContext value={leadingOffset}>
        <View style={contentStyle}>{children}</View>
      </AppContentLeadingOffsetContext>
    </AppContentWidthContext>
  );
}
