import { useSessionStore } from "@/stores/session-store";

export function supportsWorkspaceArchiveUndo(serverId: string): boolean {
  return (
    useSessionStore.getState().sessions[serverId]?.serverInfo?.features?.workspaceArchiveUndo ===
    true
  );
}
