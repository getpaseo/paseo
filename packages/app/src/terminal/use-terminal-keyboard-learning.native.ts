import { useEffect } from "react";
import { Platform } from "react-native";

import { useAppSettings } from "@/hooks/use-settings";
import { setAllowTerminalKeyboardLearning } from "../../modules/paseo-terminal";

/**
 * Pushes the setting to the Android terminal input from the app root, so the native side is
 * correct before any terminal mounts. A copy held only while a terminal is mounted could be
 * stale when the setting is turned off with no terminal open.
 */
export function useTerminalKeyboardLearning(): void {
  const { settings } = useAppSettings();
  const allow = settings.terminalKeyboardLearning;
  useEffect(() => {
    if (Platform.OS !== "android") return;
    setAllowTerminalKeyboardLearning(allow);
  }, [allow]);
}
