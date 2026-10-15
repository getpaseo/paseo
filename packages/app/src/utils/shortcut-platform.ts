import { Platform } from "react-native";
import { getIsElectronRuntimeMac } from "@/constants/layout";
import type { ShortcutOs } from "@/utils/format-shortcut";
import { isNative } from "@/constants/platform";
import { isMacUserAgent } from "@/utils/mac-user-agent";

export function getShortcutOs(): ShortcutOs {
  if (isNative) {
    return Platform.OS === "ios" ? "mac" : "non-mac";
  }
  if (getIsElectronRuntimeMac()) return "mac";
  return isMacUserAgent() ? "mac" : "non-mac";
}
