import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { resolveFocusedChatTarget } from "@/composer/focused-chat-target";
import { TaskArtifactsList } from "./task-artifacts-list";

export function WorkspaceArtifacts({
  serverId,
  workspaceId,
  onOpen,
}: {
  serverId: string;
  workspaceId?: string | null;
  onOpen(path: string): void;
}) {
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined,
  );
  const focusedAgentId = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const id = session?.focusedAgentId;
    const agent = id ? (session?.agents.get(id) ?? session?.agentDetails.get(id)) : null;
    return agent?.workspaceId === workspaceId ? (id ?? null) : null;
  });
  const agentId = useMemo(() => {
    const chat = resolveFocusedChatTarget({ serverId, layout });
    const target =
      layout && chat
        ? collectAllTabs(layout.root).find((tab) => tab.tabId === chat.tabId)?.target
        : null;
    if (target?.kind === "agent") return target.agentId;
    return target?.kind === "draft" ? null : focusedAgentId;
  }, [serverId, layout, focusedAgentId]);
  return <TaskArtifactsList serverId={serverId} agentId={agentId} onOpen={onOpen} />;
}
