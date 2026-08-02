import { useAppSettings } from "../hooks/use-settings";
import NativeGridTerminalEmulator from "./terminal-emulator-native-grid.native";
import WebViewTerminalEmulator from "./terminal-emulator-webview.native";
import type { TerminalEmulatorProps } from "./terminal-emulator-contract";

export type { TerminalEmulatorHandle } from "./terminal-emulator-contract";

export default function TerminalEmulator(props: TerminalEmulatorProps) {
  const { settings } = useAppSettings();
  const { useLegacyTerminalRenderer } = settings;
  const Renderer = useLegacyTerminalRenderer ? WebViewTerminalEmulator : NativeGridTerminalEmulator;
  const rendererKey = useLegacyTerminalRenderer ? "webview" : "native-grid";

  return <Renderer key={rendererKey} {...props} />;
}
