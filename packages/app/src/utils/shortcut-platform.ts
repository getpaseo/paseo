import { Platform } from "react-native";
import { getIsElectronRuntimeMac } from "@/constants/layout";
import type { ShortcutOs } from "@/utils/format-shortcut";
import { isNative } from "@/constants/platform";
import { getShortcutModPreference, useShortcutModStore } from "@/stores/shortcut-mod-store";

function getPlatformShortcutOs(): ShortcutOs {
  if (isNative) {
    return Platform.OS === "ios" ? "mac" : "non-mac";
  }
  if (getIsElectronRuntimeMac()) return "mac";
  if (typeof navigator === "undefined") return "non-mac";
  const ua = navigator.userAgent ?? "";
  const platform = (navigator as Navigator & { platform?: string }).platform ?? "";
  const isApple =
    /Macintosh|Mac OS|iPhone|iPad|iPod/i.test(ua) || /Mac|iPhone|iPad|iPod/i.test(platform);
  return isApple ? "mac" : "non-mac";
}

export function getShortcutOs(): ShortcutOs {
  const preference = getShortcutModPreference();
  if (preference === "cmd") return "mac";
  if (preference === "ctrl") return "non-mac";
  return getPlatformShortcutOs();
}

/** Reactive getShortcutOs — re-renders when the mod-key preference changes. */
export function useShortcutOs(): ShortcutOs {
  const preference = useShortcutModStore((s) => s.preference);
  if (preference === "cmd") return "mac";
  if (preference === "ctrl") return "non-mac";
  return getPlatformShortcutOs();
}
