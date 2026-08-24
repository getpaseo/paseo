import { useCallback, useMemo, useRef, useState } from "react";
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import type { BrowserViewerCommand } from "@getpaseo/protocol/browser-automation/client-command";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { Image } from "expo-image";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { BrowserChrome } from "@/desktop/browser/chrome";
import { DeviceSizeMenu } from "@/desktop/browser/device-size-menu";
import type { DeviceSizeSelection } from "@/desktop/browser/device-sizes";
import { resolveMirrorDeviceResize } from "./device-resize";
import { describeMirrorFailure, type MirrorCommandOutcome } from "./command";
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

type BrowserInputModifier = Extract<BrowserMirrorInput, { kind: "key" }>["modifiers"][number];

// React Native types a key event as just `{ key }`, but web hands over the DOM
// event, which carries the flags a shortcut needs.
const KEY_MODIFIER_FLAGS: ReadonlyArray<readonly [string, BrowserInputModifier]> = [
  ["altKey", "Alt"],
  ["ctrlKey", "Control"],
  ["metaKey", "Meta"],
  ["shiftKey", "Shift"],
];

function readKeyModifiers(source: object): BrowserInputModifier[] {
  const held: BrowserInputModifier[] = [];
  for (const [flag, modifier] of KEY_MODIFIER_FLAGS) {
    if (Reflect.get(source, flag) === true) {
      held.push(modifier);
    }
  }
  return held;
}

/** Shift still types a character; the rest turn a key into a command. */
function isShortcutModifier(modifier: BrowserInputModifier): boolean {
  return modifier !== "Shift";
}

export function BrowserMirrorPane({
  browserId,
  serverId,
  workspaceId,
  isInteractive = true,
}: BrowserMirrorPaneProps) {
  const { t } = useTranslation();
  const { tab, run } = useRemoteBrowserTab(serverId, workspaceId, browserId);
  const [actionError, setActionError] = useState<string | null>(null);
  const [paneSize, setPaneSize] = useState<PaneSize | null>(null);
  // An announced tab carries no viewport, so the host's current size is
  // unreadable from here; the menu reflects what this viewer picked.
  const [deviceSize, setDeviceSize] = useState<DeviceSizeSelection>(INITIAL_DEVICE_SIZE);
  const { uri, deviceWidth, deviceHeight, error } = useBrowserScreencast(
    serverId,
    workspaceId,
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

  const disconnectedLabel = t("common.errors.daemonClientUnavailable");
  const failureMessage = useCallback(
    (outcome: MirrorCommandOutcome) =>
      outcome.status === "ok" ? null : describeMirrorFailure(outcome, disconnectedLabel),
    [disconnectedLabel],
  );

  // A toolbar action is rare and deliberate, so its outcome replaces whatever the
  // row was showing — including clearing a stale input failure once one succeeds.
  const runAction = useCallback(
    (command: BrowserViewerCommand) => {
      void run(command).then((outcome) => setActionError(failureMessage(outcome)));
    },
    [failureMessage, run],
  );

  const sendInput = useCallback(
    (event: BrowserMirrorInput) => {
      void (async () => {
        const message = failureMessage(
          await run({ command: "input_at", args: { browserId, event } }),
        );
        // Pointer input fires many times a second, so a success may not clear the
        // row and a repeated failure re-sets the same string, which React drops.
        // The result is one standing error, not one per event.
        if (message) {
          setActionError(message);
        }
      })();
    },
    [browserId, failureMessage, run],
  );

  const goBack = useCallback(
    () => runAction({ command: "back", args: { browserId } }),
    [browserId, runAction],
  );
  const goForward = useCallback(
    () => runAction({ command: "forward", args: { browserId } }),
    [browserId, runAction],
  );
  const reload = useCallback(
    () => runAction({ command: "reload", args: { browserId } }),
    [browserId, runAction],
  );

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const { key } = event.nativeEvent;
      if (!key) {
        return;
      }
      const modifiers = readKeyModifiers(event.nativeEvent);
      // A shortcut is meant for the guest, so stop the viewer acting on it too:
      // otherwise Cmd+R reloads Paseo instead of the mirrored page.
      if (modifiers.some(isShortcutModifier)) {
        event.preventDefault();
      }
      sendInput({ kind: "key", key, modifiers });
    },
    [sendInput],
  );

  const navigate = useCallback(
    (url: string) => runAction({ command: "navigate", args: { browserId, url } }),
    [browserId, runAction],
  );

  const selectDeviceSize = useCallback(
    (selection: DeviceSizeSelection) => {
      const resize = resolveMirrorDeviceResize({ selection, paneSize });
      if (resize.status === "unavailable") {
        return;
      }
      setDeviceSize(selection);
      runAction({
        command: "resize",
        args: { browserId, width: resize.width, height: resize.height },
      });
    },
    [browserId, paneSize, runAction],
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

  // Same row, same reading as the local pane's `browser.lastError`. A failed
  // action is the newer fact, so it sits in front of a stale stream error.
  const paneError = actionError ?? error;

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
      {paneError ? (
        <View style={styles.errorRow}>
          <Text numberOfLines={1} style={styles.errorText}>
            {paneError}
          </Text>
        </View>
      ) : null}
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
          <Text style={styles.message}>{t("workspace.browser.mirror.connecting")}</Text>
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
  errorRow: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[500],
  },
}));
