import { useHasActiveDescendants } from "@/subagents/select";
import { subagentActivityStatus } from "@/subagents/activity";
import { useShallow } from "zustand/shallow";
import { useProviderIcon } from "@/components/provider-icons";
import type { PanelDescriptor } from "@/panels/panel-registry";
import { useSessionStore, selectAgentTurnPresentation, type Agent } from "@/stores/session-store";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";

function formatProviderLabel(provider: Agent["provider"]): string {
  if (!provider) {
    return "Agent";
  }
  return provider
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveAgentLabel(title: string | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}

export function useAgentDescriptor(
  target: { kind: "agent"; agentId: string },
  context: { serverId: string },
): PanelDescriptor {
  const descriptorState = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[context.serverId];
      const agent =
        session?.agents?.get(target.agentId) ?? session?.agentDetails?.get(target.agentId) ?? null;
      return {
        provider: agent?.provider ?? "codex",
        title: agent?.title ?? null,
        status: agent?.status ?? null,
        pendingPermissionCount: agent?.pendingPermissions.length ?? 0,
        requiresAttention: agent?.requiresAttention ?? false,
        attentionReason: agent?.attentionReason ?? null,
        isTurnActive: selectAgentTurnPresentation(session, target.agentId).isActive,
      };
    }),
  );
  const hasActiveDescendants = useHasActiveDescendants({
    serverId: context.serverId,
    parentAgentId: target.agentId,
  });
  const icon = useProviderIcon(descriptorState.provider, context.serverId);
  return buildAgentDescriptor({ ...descriptorState, hasActiveDescendants, icon });
}

export function buildAgentDescriptor(input: {
  provider: Agent["provider"];
  title: string | null;
  status: Agent["status"] | null;
  pendingPermissionCount: number;
  requiresAttention: boolean;
  attentionReason: Agent["attentionReason"];
  isTurnActive: boolean;
  hasActiveDescendants: boolean;
  icon: PanelDescriptor["icon"];
}): PanelDescriptor {
  const provider = input.provider;
  const label = resolveAgentLabel(input.title);

  return {
    label: label ?? "",
    subtitle: `${formatProviderLabel(provider)} agent`,
    tooltip: label ?? `${formatProviderLabel(provider)} agent`,
    titleState: label ? "ready" : "loading",
    icon: input.icon,
    statusBucket: input.status
      ? deriveSidebarStateBucket({
          status: subagentActivityStatus({
            status: input.status,
            isSelfActive: input.isTurnActive,
            hasActiveDescendants: input.hasActiveDescendants,
          }),
          pendingPermissionCount: input.pendingPermissionCount,
          requiresAttention: input.requiresAttention,
          attentionReason: input.attentionReason,
        })
      : null,
  };
}
