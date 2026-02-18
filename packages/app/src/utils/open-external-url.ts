import * as Linking from "expo-linking";
import { Platform } from "react-native";
import { getTauri } from "@/utils/tauri";

export async function openExternalUrl(url: string): Promise<void> {
  if (Platform.OS === "web") {
    const opener = getTauri()?.opener?.openUrl;
    if (typeof opener === "function") {
      await opener(url);
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  await Linking.openURL(url);
}
