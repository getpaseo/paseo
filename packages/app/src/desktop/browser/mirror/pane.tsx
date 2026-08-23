import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View, type LayoutChangeEvent, type GestureResponderEvent } from "react-native";
import { Image } from "expo-image";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useBrowserScreencast } from "./use-screencast";

interface BrowserMirrorPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  isInteractive?: boolean;
}

interface ViewportFit {
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface PaneSize {
  width: number;
  height: number;
}

const SCROLL_GESTURE_THRESHOLD_PX = 6;

function fitViewport(pane: PaneSize, deviceWidth: number, deviceHeight: number): ViewportFit {
  const scale = Math.min(pane.width / deviceWidth, pane.height / deviceHeight);
  return {
    scale,
    offsetX: (pane.width - deviceWidth * scale) / 2,
    offsetY: (pane.height - deviceHeight * scale) / 2,
  };
}

function toGuestPoint(
  event: GestureResponderEvent,
  fit: ViewportFit,
  deviceWidth: number,
  deviceHeight: number,
): { x: number; y: number } {
  const { locationX, locationY } = event.nativeEvent;
  return {
    x: Math.min(Math.max((locationX - fit.offsetX) / fit.scale, 0), deviceWidth),
    y: Math.min(Math.max((locationY - fit.offsetY) / fit.scale, 0), deviceHeight),
  };
}

export function BrowserMirrorPane({
  browserId,
  serverId,
  workspaceId,
  isInteractive = true,
}: BrowserMirrorPaneProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const client = useHostRuntimeClient(serverId);
  const { uri, deviceWidth, deviceHeight, error } = useBrowserScreencast(serverId, browserId);
  const [paneSize, setPaneSize] = useState<PaneSize | null>(null);
  const gestureRef = useRef<{ x: number; y: number; scrolled: boolean } | null>(null);

  const hasFrame = uri !== null && deviceWidth > 0 && deviceHeight > 0;
  const fit = useMemo(
    () => (paneSize && hasFrame ? fitViewport(paneSize, deviceWidth, deviceHeight) : null),
    [paneSize, hasFrame, deviceWidth, deviceHeight],
  );

  const sendInput = useCallback(
    (event: BrowserMirrorInput) => {
      if (!client) {
        return;
      }
      void client.runBrowserCommand({
        command: buildInputCommand(browserId, event),
        workspaceId,
      });
    },
    [browserId, client, workspaceId],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setPaneSize({ width, height });
  }, []);

  const handleResponderGrant = useCallback(
    (event: GestureResponderEvent) => {
      if (!fit) {
        return;
      }
      const point = toGuestPoint(event, fit, deviceWidth, deviceHeight);
      gestureRef.current = { ...point, scrolled: false };
    },
    [deviceHeight, deviceWidth, fit],
  );

  const handleResponderMove = useCallback(
    (event: GestureResponderEvent) => {
      const origin = gestureRef.current;
      if (!fit || !origin) {
        return;
      }
      const point = toGuestPoint(event, fit, deviceWidth, deviceHeight);
      const deltaX = origin.x - point.x;
      const deltaY = origin.y - point.y;
      if (
        !origin.scrolled &&
        Math.abs(deltaX) < SCROLL_GESTURE_THRESHOLD_PX &&
        Math.abs(deltaY) < SCROLL_GESTURE_THRESHOLD_PX
      ) {
        return;
      }
      gestureRef.current = { x: point.x, y: point.y, scrolled: true };
      sendInput({ kind: "wheel", x: point.x, y: point.y, deltaX, deltaY });
    },
    [deviceHeight, deviceWidth, fit, sendInput],
  );

  const handleResponderRelease = useCallback(
    (event: GestureResponderEvent) => {
      const origin = gestureRef.current;
      gestureRef.current = null;
      if (!fit || !origin || origin.scrolled) {
        return;
      }
      const point = toGuestPoint(event, fit, deviceWidth, deviceHeight);
      sendInput({ kind: "mouse", x: point.x, y: point.y, button: "left", clickCount: 1 });
    },
    [deviceHeight, deviceWidth, fit, sendInput],
  );

  const shouldCaptureResponder = useCallback(() => isInteractive && fit !== null, [
    fit,
    isInteractive,
  ]);

  const messageStyle = useMemo(
    () => [styles.message, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );

  return (
    <View
      style={styles.container}
      onLayout={handleLayout}
      onStartShouldSetResponder={shouldCaptureResponder}
      onMoveShouldSetResponder={shouldCaptureResponder}
      onResponderGrant={handleResponderGrant}
      onResponderMove={handleResponderMove}
      onResponderRelease={handleResponderRelease}
    >
      {hasFrame ? (
        <Image
          source={{ uri }}
          style={styles.frame}
          contentFit="contain"
          cachePolicy="none"
          transition={0}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Text style={messageStyle}>
          {error ?? t("workspace.browser.mirror.connecting")}
        </Text>
      )}
    </View>
  );
}

type BrowserMirrorInput =
  | { kind: "mouse"; x: number; y: number; button: "left"; clickCount: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number };

function buildInputCommand(
  browserId: string,
  event: BrowserMirrorInput,
): BrowserAutomationCommand {
  if (event.kind === "wheel") {
    return { command: "input_at", args: { browserId, event } };
  }
  return {
    command: "input_at",
    args: { browserId, event: { ...event, modifiers: [] } },
  };
}

const styles = StyleSheet.create(() => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  frame: {
    width: "100%",
    height: "100%",
  },
  message: {
    fontSize: 13,
    textAlign: "center",
    padding: 16,
  },
}));
