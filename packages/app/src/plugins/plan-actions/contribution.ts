import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { InstalledPlugin } from "../types";
import { createPluginAgentActionContext, type PluginNavigation } from "../actions";
import { createPluginClientStateSource } from "../client-state/source";

export async function runPlanContribution(input: {
  client: DaemonClient;
  plugin: InstalledPlugin;
  contributionId: string;
  serverId: string;
  workspaceId: string;
  agentId: string;
  plan: { callId: string; text: string; turnId?: string; permissionRequestId: string };
  signal: AbortSignal;
  navigation: PluginNavigation;
  prepare?: boolean;
  profileId?: string;
}): Promise<void> {
  const contribution = input.plugin.planActions.find(
    (action) => action.id === input.contributionId,
  );
  if (!contribution || contribution.disabledReason || input.plugin.lifetime.signal.aborted)
    throw new Error(contribution?.disabledReason ?? "Handoff is unavailable.");
  if (contribution.requiresAgentProfile && !input.profileId)
    throw new Error("Choose an agent profile to hand off this plan.");
  const context = createPluginAgentActionContext({
    plugin: input.plugin,
    state: createPluginClientStateSource(input.serverId),
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    navigation: input.navigation,
  });
  if (!context) throw new Error("The plan's agent or workspace is unavailable.");
  if (input.prepare && contribution.onAvailable) {
    try {
      await contribution.onAvailable({ signal: input.signal, ...context, plan: input.plan });
    } catch {
      // Preparation is opportunistic; the action itself reports a definitive failure.
    }
  }
  await contribution.onPress({
    signal: input.signal,
    ...context,
    plan: input.plan,
    profileId: input.profileId,
  });
  if (input.signal.aborted)
    throw new Error("Plan action interrupted. Retry to inspect its result.");
}
