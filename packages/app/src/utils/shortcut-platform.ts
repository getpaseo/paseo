import { Platform } from "react-native";
import { getIsTauriMac } from "@/constants/layout";
import type { ShortcutOs } from "@/utils/format-shortcut";

export function getShortcutOs(): ShortcutOs {
  if (Platform.OS !== "web") {
    return Platform.OS === "ios" ? "mac" : "non-mac";
  }
  if (getIsTauriMac()) return "mac";
  if (typeof navigator === "undefined") return "non-mac";
  const ua = navigator.userAgent ?? "";
  const platform = (navigator as any).platform ?? "";
  const isApple =
    /Macintosh|Mac OS|iPhone|iPad|iPod/i.test(ua) ||
    /Mac|iPhone|iPad|iPod/i.test(platform);
  return isApple ? "mac" : "non-mac";
}

