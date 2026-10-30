import { createContext, type ReactNode } from "react";
import { View } from "react-native";

// The app shell knows its allocation before nested native screen roots resize.
// Null keeps the existing measured layout on platforms without modern window layout.
export const AppContentWidthContext = createContext<number | null>(null);
export const AppContentLeadingOffsetContext = createContext<number | null>(null);

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
