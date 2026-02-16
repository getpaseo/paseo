import * as Linking from "expo-linking";
import { Platform } from "react-native";
import { getIsTauri } from "@/constants/layout";

interface TauriWindowWithOpener {
  __TAURI__?: {
    opener?: {
      openUrl?: (url: string) => Promise<void>;
    };
  };
}

export async function openExternalUrl(url: string): Promise<void> {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && getIsTauri()) {
      const opener = (window as TauriWindowWithOpener).__TAURI__?.opener?.openUrl;
      if (typeof opener === "function") {
        await opener(url);
        return;
      }
    }

    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  await Linking.openURL(url);
}
