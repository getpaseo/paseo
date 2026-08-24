import { useCallback, useMemo, useRef, useState } from "react";
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { Image } from "expo-image";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { BrowserChrome } from "@/desktop/browser/chrome";
import { DeviceSizeMenu, type DeviceSizeSelection } from "@/desktop/browser/device-size-menu";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { BrowserMirrorInputSurface } from "./input-surface";
import type { BrowserMirrorInput } from "./input-surface.types";
import { useBrowserScreencast } from "./use-screencast";
import { useRemoteBrowserTab } from "./use-remote-tab";
import { fitViewport, type PaneSize } from "./viewport";

const INITIAL_DEVICE_SIZE: DeviceSizeSelection = {
  id: "responsive",
  isLandscape: false,
  size: null,
};

interface BrowserMirrorPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  isInteractive?: boolean;
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
  const [paneSize, setPaneSize] = useState<PaneSize | null>(null);
  // An announced tab carries no viewport, so the host's current size is
  // unreadable from here; the menu reflects what this viewer picked.
  const [deviceSize, setDeviceSize] = useState<DeviceSizeSelection>(INITIAL_DEVICE_SIZE);
  const { uri, deviceWidth, deviceHeight, error } = useBrowserScreencast(
    serverId,
    browserId,
    paneSize,
  );
  const keyboardRef = useRef<EditingTextInputHandle>(null);
  const urlInputRef = useRef<EditingTextInputHandle>(null);

  const hasFrame = uri !== null && deviceWidth > 0 && deviceHeight > 0;
  const frameSource = useMemo(() => (uri === null ? null : { uri }), [uri]);
  const guest = useMemo(() => ({ deviceWidth, deviceHeight }), [deviceHeight, deviceWidth]);
  const fit = useMemo(
    () => (paneSize && hasFrame ? fitViewport(paneSize, guest) : null),
    [guest, hasFrame, paneSize],
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
        command: { command: "input_at", args: { browserId, event } },
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
        sendInput({ kind: "key", key, modifiers: [] });
      }
    },
    [sendInput],
  );

  const navigate = useCallback(
    (url: string) => run({ command: "navigate", args: { browserId, url } }),
    [browserId, run],
  );

  const selectDeviceSize = useCallback(
    (selection: DeviceSizeSelection) => {
      // "Responsive" has no remote equivalent: the host handler only sets fixed
      // viewports and `resize` requires positive dimensions, so nothing can put
      // the remote tab back into responsive mode. The local pane frees its
      // webview to fill the pane; from the mirror the closest thing is sizing
      // the remote tab to this viewer's pane, so "Responsive" means "fit my
      // window".
      const width = selection.size?.width ?? paneSize?.width;
      const height = selection.size?.height ?? paneSize?.height;
      if (!width || !height) {
        return;
      }
      setDeviceSize(selection);
      run({
        command: "resize",
        args: { browserId, width: Math.round(width), height: Math.round(height) },
      });
    },
    [browserId, paneSize, run],
  );

  const deviceActions = useMemo(
    () => (
      <DeviceSizeMenu
        selectedId={deviceSize.id}
        isLandscape={deviceSize.isLandscape}
        onSelect={selectDeviceSize}
      />
    ),
    [deviceSize, selectDeviceSize],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setPaneSize({ width, height });
  }, []);

  const focusKeyboard = useCallback(() => {
    keyboardRef.current?.focus();
  }, []);

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
        trailing={deviceActions}
      />
      <BrowserMirrorInputSurface
        fit={fit}
        guest={guest}
        isInteractive={isInteractive}
        onInput={sendInput}
        onFocusKeyboard={focusKeyboard}
        onLayout={handleLayout}
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
      </BrowserMirrorInputSurface>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
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
