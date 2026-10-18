import { useIsCompactFormFactor } from "@/constants/layout";
import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function WorkspaceSurface({
  children,
  framed = true,
  size = "default",
  testID,
}: {
  children: ReactNode;
  framed?: boolean;
  size?: "default" | "small";
  testID?: string;
}) {
  const isCompact = useIsCompactFormFactor();
  const showFrame = framed && !isCompact;
  const radiusStyle = showFrame && size === "small" ? styles.smallRadius : undefined;
  return (
    <View style={[showFrame ? styles.frame : styles.container, radiusStyle]} testID={testID}>
      <View style={[showFrame ? styles.content : styles.container, radiusStyle]}>{children}</View>
    </View>
  );
}

// The shell owns the card, so terminals, chats, and editors keep the same usable bounds.
// Compact surfaces stay edge-to-edge; no appearance key is added around retained panels.
const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  smallRadius: {
    borderRadius: theme.workspaceFrame.radius * 0.8,
  },
  frame: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    marginHorizontal: theme.workspaceFrame.inset,
    marginTop: theme.workspaceFrame.topInset,
    marginBottom: theme.workspaceFrame.inset,
    borderRadius: theme.workspaceFrame.radius,
    backgroundColor: theme.colors.surface0,
    shadowColor: theme.workspaceFrame.shadowColor,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    shadowOpacity: 1,
    elevation: theme.workspaceFrame.elevation,
  },
  content: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    borderRadius: theme.workspaceFrame.radius,
    overflow: "hidden",
  },
}));
