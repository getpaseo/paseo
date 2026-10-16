import { getIsElectron, isWeb } from "@/constants/platform";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";
import { isHttpUrl } from "@/utils/http-url";
import { openExternalUrl } from "@/utils/open-external-url";
import { openWorkspaceBrowser } from "@/workspace-tabs/browser";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export interface WebUrlClick {
  metaKey?: boolean;
  nativeEvent?: unknown;
}

export function isSystemBrowserClick(event?: WebUrlClick): boolean {
  if (event?.metaKey === true) return true;
  const native = event?.nativeEvent;
  return !!native && typeof native === "object" && "metaKey" in native && native.metaKey === true;
}

/** Capture the click and route before yielding: later navigation cannot change its destination. */
export async function openWebUrl(url: string, event?: WebUrlClick): Promise<void> {
  if (!isHttpUrl(url)) return;
  if (isWeb && getIsElectron() && !isSystemBrowserClick(event)) {
    const workspace = parseHostWorkspaceRouteFromPathname(window.location.pathname);
    const workspaceKey = workspace && buildWorkspaceTabPersistenceKey(workspace);
    if (workspaceKey) {
      const result = openWorkspaceBrowser({ workspaceKey, url, intent: "reveal" });
      if (!result.ok) throw new Error(`Unable to open workspace browser: ${result.code}`);
      return;
    }
  }
  await openExternalUrl(url);
}
