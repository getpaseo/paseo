import * as Linking from "expo-linking";
import { Platform } from "react-native";
import { getDesktopHost } from "@/desktop/host";
import { createWorkspaceBrowser } from "@/stores/browser-store";
import { useWorkspaceLayoutStore, buildWorkspaceTabPersistenceKey } from "@/stores/workspace-layout-store";
import { getNavigationActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";

export async function openExternalUrl(url: string): Promise<void> {
  if (Platform.OS === "web") {
    const desktopHost = getDesktopHost();
    const activeWorkspace = desktopHost ? getNavigationActiveWorkspaceSelection() : null;
    const workspaceKey = activeWorkspace
      ? buildWorkspaceTabPersistenceKey(activeWorkspace)
      : null;

    if (workspaceKey) {
      const browser = createWorkspaceBrowser({ initialUrl: url });
      const tabId = useWorkspaceLayoutStore.getState().openTab(workspaceKey, {
        kind: "browser",
        browserId: browser.browserId,
      });
      if (tabId) {
        useWorkspaceLayoutStore.getState().focusTab(workspaceKey, tabId);
        return;
      }
    }

    const opener = desktopHost?.opener?.openUrl;
    if (typeof opener === "function") {
      await opener(url);
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  await Linking.openURL(url);
}
