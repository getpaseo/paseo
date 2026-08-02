import { useEffect } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useAppSettings } from "../hooks/use-settings";
import { resolveTerminalRendererSelection } from "../terminal/native-renderer/terminal-renderer-capability";
import NativeGridTerminalEmulator from "./terminal-emulator-native-grid.native";
import WebViewTerminalEmulator from "./terminal-emulator-webview.native";
import type { TerminalEmulatorProps } from "./terminal-emulator-contract";

export type { TerminalEmulatorHandle } from "./terminal-emulator-contract";

function UnsupportedNativeTerminal({ streamKey, onRendererReadyChange }: TerminalEmulatorProps) {
  const { t } = useTranslation();

  useEffect(() => {
    onRendererReadyChange?.({ streamKey, isReady: false });
  }, [onRendererReadyChange, streamKey]);

  return (
    <View style={styles.unsupportedContainer}>
      <Text style={styles.unsupportedText}>{t("workspace.terminal.updateHost")}</Text>
    </View>
  );
}

export default function TerminalEmulator(props: TerminalEmulatorProps) {
  const { settings } = useAppSettings();
  const { useLegacyTerminalRenderer } = settings;
  const rendererSelection = resolveTerminalRendererSelection({
    useLegacyTerminalRenderer,
    supportsTerminalInputModeReplay: props.supportsTerminalInputModeReplay,
  });

  if (rendererSelection === "update-host") {
    return <UnsupportedNativeTerminal {...props} />;
  }

  const Renderer =
    rendererSelection === "webview" ? WebViewTerminalEmulator : NativeGridTerminalEmulator;

  return <Renderer key={rendererSelection} {...props} />;
}

const styles = StyleSheet.create((theme) => ({
  unsupportedContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  unsupportedText: {
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
