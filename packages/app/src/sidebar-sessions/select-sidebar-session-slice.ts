import { useSessionStore, type Agent } from "@/stores/session-store";

export type SidebarSessionSlice = {
  title: string | null;
  cwd: string;
  provider: Agent["provider"];
  lastActivityAt: Date;
  archivedAt: Date | null;
} | null;

export function selectSidebarSessionSlice(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string,
): SidebarSessionSlice {
  const agent = state.sessions[serverId]?.agents?.get(agentId) ?? null;
  if (!agent) {
    return null;
  }
  return {
    title: agent.title ?? null,
    cwd: agent.cwd,
    provider: agent.provider,
    lastActivityAt: agent.lastActivityAt,
    archivedAt: agent.archivedAt ?? null,
  };
}
