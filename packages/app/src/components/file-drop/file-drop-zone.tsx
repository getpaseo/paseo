import type { ReactNode, RefObject } from "react";
import { useCallback, useMemo, useRef } from "react";
import { View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSharedValue } from "react-native-reanimated";
import { isWeb } from "@/constants/platform";
import { FileDropContext, type FileDropContextValue } from "./context";
import { FileDropBackdrop } from "./file-drop-backdrop";
import { useDropListeners } from "./use-drop-listeners";
import type { FileDropSink } from "./types";

interface FileDropZoneProps {
  children: ReactNode;
  /** When true, no drops are accepted and the backdrop stays hidden. */
  disabled?: boolean;
  /** Styles the drop area (defaults to filling its parent). The backdrop fills this area. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Defines a drag-and-drop area and renders its dim backdrop. Files are consumed by any
 * descendant calling `useFileDrop` — the drop area, the backdrop, and the consumer are
 * decoupled, so a consumer's layout can never collapse the backdrop.
 */
export function FileDropZone({ children, disabled = false, style }: FileDropZoneProps) {
  const isDragging = useSharedValue(false);
  const suppressed = useSharedValue(false);
  const hasSink = useSharedValue(false);
  const activeGetSink = useRef<(() => FileDropSink | null) | null>(null);

  const registerSink = useCallback(
    (getSink: () => FileDropSink | null) => {
      activeGetSink.current = getSink;
      hasSink.value = true;
      return () => {
        if (activeGetSink.current === getSink) {
          activeGetSink.current = null;
          hasSink.value = false;
        }
      };
    },
    [hasSink],
  );

  const getSink = useCallback(() => activeGetSink.current?.() ?? null, []);

  const ctx = useMemo<FileDropContextValue>(
    () => ({ isDragging, suppressed, hasSink, registerSink }),
    [isDragging, suppressed, hasSink, registerSink],
  );

  const containerRef = useDropListeners({ isDragging, suppressed, hasSink, getSink, disabled });

  const targetStyle = useMemo(() => [styles.target, style], [style]);

  // On native there is no web drag-and-drop, so skip the listeners and the backdrop — but still
  // render the styled layout View (callers use FileDropZone as their container) and provide
  // context so useFileDrop no-ops safely.
  if (!isWeb) {
    return (
      <FileDropContext.Provider value={ctx}>
        <View style={targetStyle}>{children}</View>
      </FileDropContext.Provider>
    );
  }

  return (
    <FileDropContext.Provider value={ctx}>
      <View ref={containerRef as unknown as RefObject<View>} style={targetStyle}>
        {children}
        <FileDropBackdrop />
      </View>
    </FileDropContext.Provider>
  );
}

// No default flex: the caller's `style` owns sizing (full-area surfaces pass flex:1; a dialog
// passes a content-sized style). `position` anchors the absolutely-positioned backdrop.
const styles = StyleSheet.create({
  target: {
    position: "relative",
  },
});
