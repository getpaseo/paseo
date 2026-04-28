import { Platform } from "react-native";
import { getIsElectronRuntimeMac } from "@/constants/layout";
import type { ShortcutOs } from "@/utils/format-shortcut";
import { isNative } from "@/constants/platform";

export function getShortcutOs(): ShortcutOs {
  if (isNative) {
    return Platform.OS === "ios" ? "mac" : "non-mac";
  }
  if (getIsElectronRuntimeMac()) return "mac";
  if (typeof navigator === "undefined") return "non-mac";
  const ua = navigator.userAgent ?? "";
  const platform = (navigator as any).platform ?? "";
  const isApple =
    /Macintosh|Mac OS|iPhone|iPad|iPod/i.test(ua) || /Mac|iPhone|iPad|iPod/i.test(platform);
  return isApple ? "mac" : "non-mac";
}
