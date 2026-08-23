import { useCallback, useMemo, useRef, useState } from "react";
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import { Text, View, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import { Image } from "expo-image";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { BrowserChrome } from "@/desktop/browser/chrome";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useBrowserScreencast } from "./use-screencast";
import { useRemoteBrowserTab } from "./use-remote-tab";
import { fitViewport, toGuestPoint, type PaneSize } from "./viewport";

interface BrowserMirrorPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  isInteractive?: boolean;
}

const SCROLL_GESTURE_THRESHOLD_PX = 6;

function toPanePoint(event: GestureResponderEvent): { x: number; y: number } {
  return { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
}

export function BrowserMirrorPane({
  browserId,
  serverId,
  workspaceId,
  isInteractive = true,
}: BrowserMirrorPaneProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const { tab, run } = useRemoteBrowserTab(serverId, workspaceId, browserId);
  const { uri, deviceWidth, deviceHeight, error } = useBrowserScreencast(serverId, browserId);
  const [paneSize, setPaneSize] = useState<PaneSize | null>(null);
  const gestureRef = useRef<{ x: number; y: number; scrolled: boolean } | null>(null);
  const keyboardRef = useRef<EditingTextInputHandle>(null);
  const urlInputRef = useRef<EditingTextInputHandle>(null);

  const hasFrame = uri !== null && deviceWidth > 0 && deviceHeight > 0;
  const frameSource = useMemo(() => (uri === null ? null : { uri }), [uri]);
  const fit = useMemo(
    () => (paneSize && hasFrame ? fitViewport(paneSize, { deviceWidth, deviceHeight }) : null),
    [paneSize, hasFrame, deviceWidth, deviceHeight],
  );

  // Size the frame explicitly: expo-image wraps the <img> in its own auto-sized
  // box, so percentage or absolute fills collapse to zero. These are the exact
  // letterbox dimensions toGuestPoint maps against.
  const frameStyle = useMemo(
    () => (fit ? { width: deviceWidth * fit.scale, height: deviceHeight * fit.scale } : null),
    [deviceHeight, deviceWidth, fit],
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

  const goBack = useCallback(() => run({ command: "back", args: { browserId } }), [browserId, run]);
  const goForward = useCallback(
    () => run({ command: "forward", args: { browserId } }),
    [browserId, run],
  );
  const reload = useCallback(
    () => run({ command: "reload", args: { browserId } }),
    [browserId, run],
  );

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const { key } = event.nativeEvent;
      if (key) {
        sendInput({ kind: "key", key });
      }
    },
    [sendInput],
  );

  const navigate = useCallback(
    (url: string) => run({ command: "navigate", args: { browserId, url } }),
    [browserId, run],
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
      const point = toGuestPoint(toPanePoint(event), fit, { deviceWidth, deviceHeight });
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
      const point = toGuestPoint(toPanePoint(event), fit, { deviceWidth, deviceHeight });
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
      const point = toGuestPoint(toPanePoint(event), fit, { deviceWidth, deviceHeight });
      sendInput({ kind: "mouse", x: point.x, y: point.y, button: "left", clickCount: 1 });
      // Tapping the page is what arms typing, mirroring how a real click focuses it.
      keyboardRef.current?.focus();
    },
    [deviceHeight, deviceWidth, fit, sendInput],
  );

  const shouldCaptureResponder = useCallback(
    () => isInteractive && fit !== null,
    [fit, isInteractive],
  );

  return (
    <View style={styles.root}>
      <BrowserChrome
        url={tab?.url ?? ""}
        canGoBack={Boolean(tab?.canGoBack)}
        canGoForward={Boolean(tab?.canGoForward)}
        isLoading={tab?.isLoading ?? false}
        onBack={goBack}
        onForward={goForward}
        onReload={reload}
        onNavigate={navigate}
        urlInputRef={urlInputRef}
      />
      <View
        style={styles.container}
        onLayout={handleLayout}
        onStartShouldSetResponder={shouldCaptureResponder}
        onMoveShouldSetResponder={shouldCaptureResponder}
        onResponderGrant={handleResponderGrant}
        onResponderMove={handleResponderMove}
        onResponderRelease={handleResponderRelease}
      >
        {hasFrame && frameStyle ? (
          <Image
            source={frameSource}
            style={frameStyle}
            contentFit="contain"
            cachePolicy="none"
            transition={0}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Text style={styles.message}>{error ?? t("workspace.browser.mirror.connecting")}</Text>
        )}
        <EditingTextInput
          ref={keyboardRef}
          initialValue=""
          onKeyPress={handleKeyPress}
          style={styles.keyboardCapture}
          accessibilityLabel={t("workspace.browser.mirror.keyboard")}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
      </View>
    </View>
  );
}

type BrowserMirrorInput =
  | { kind: "mouse"; x: number; y: number; button: "left"; clickCount: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; key: string };

function buildInputCommand(browserId: string, event: BrowserMirrorInput): BrowserAutomationCommand {
  if (event.kind === "wheel") {
    return { command: "input_at", args: { browserId, event } };
  }
  if (event.kind === "key") {
    return { command: "input_at", args: { browserId, event: { ...event, modifiers: [] } } };
  }
  return {
    command: "input_at",
    args: { browserId, event: { ...event, modifiers: [] } },
  };
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  keyboardCapture: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    padding: 0,
  },
  message: {
    fontSize: 13,
    textAlign: "center",
    padding: 16,
    color: theme.colors.foregroundMuted,
  },
}));
