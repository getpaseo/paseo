import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

/** Opens a URL in a Paseo browser tab of one workspace. Only the desktop app has those tabs. */
export function openUrlInWorkspaceBrowser({
  serverId,
  workspaceId,
  url,
}: {
  serverId: string;
  workspaceId: string;
  url: string;
}): void {
  if (!getIsElectron()) return;
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (!workspaceKey) return;
  const { browserId } = createWorkspaceBrowser({ initialUrl: url });
  useWorkspaceLayoutStore.getState().openTab({
    workspaceKey,
    target: { kind: "browser", browserId },
    intent: "reveal",
  });
}
