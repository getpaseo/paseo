import type { DaemonServerInfo } from "@/stores/session-store";

export function canManageWorkspaceLaunches(
  serverInfo: Pick<DaemonServerInfo, "features"> | null | undefined,
): boolean {
  return serverInfo?.features?.workspaceLaunchManagement === true;
}
