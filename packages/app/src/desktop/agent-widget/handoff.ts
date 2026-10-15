import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { AgentWidgetBridge, WidgetAction } from "@getpaseo/protocol/desktop-agent-widget";
import { pluginRegistry } from "@/plugins/registry";
import { runPlanContribution } from "@/plugins/plan-actions/contribution";
import { createPluginNavigation } from "@/plugins/navigation";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { projectWidgetRequest } from "./model";

export function handoffReason(
  serverId: string,
  workspaceId: string | undefined,
  callId: string | undefined,
) {
  if (!workspaceId || !callId) return "This plan cannot be handed off.";
  const plugin = pluginRegistry
    .getSnapshot()
    .find(
      (entry) =>
        entry.serverId === serverId &&
        entry.id === "paseo-workflow" &&
        !entry.lifetime.signal.aborted,
    );
  const action = plugin?.planActions.find((entry) => entry.id === "handoff");
  return action?.disabledReason ?? (action ? undefined : "Install paseo-workflow to use Handoff.");
}

export async function handoffWidgetPlan(input: {
  client: DaemonClient;
  bridge: AgentWidgetBridge;
  serverId: string;
  agentId: string;
  workspaceId: string | undefined;
  request: AgentPermissionRequest;
  operationId: string;
  action: Extract<WidgetAction, { type: "handoff" }>;
}): Promise<void> {
  const { serverId, agentId, request, action, bridge, operationId } = input;
  const item = projectWidgetRequest({
    serverId,
    agentId,
    request,
    agentTitle: "",
    workspace: "",
    workspaceId: input.workspaceId,
  });
  if (!item || item.kind !== "plan" || !item.planCallId || !item.planText || !item.workspaceId)
    throw new Error("This plan cannot be handed off.");
  if (item.planCallId !== action.planCallId || item.planText !== action.planText)
    throw new Error("This plan has been replaced.");
  if (!action.profileId) throw new Error("Choose an agent profile to hand off this plan.");
  const reason = handoffReason(serverId, item.workspaceId, item.planCallId);
  if (reason) throw new Error(reason);
  const plugin = pluginRegistry
    .getSnapshot()
    .find((entry) => entry.serverId === serverId && entry.id === "paseo-workflow");
  if (!plugin) throw new Error("Handoff is unavailable.");
  const navigation = createPluginNavigation({ serverId, workspaceId: item.workspaceId });
  const progress = setInterval(() => {
    void bridge.progress(operationId).catch(() => undefined);
  }, 10_000);
  try {
    await runPlanContribution({
      client: input.client,
      plugin,
      contributionId: "handoff",
      serverId,
      workspaceId: item.workspaceId,
      agentId,
      plan: { callId: item.planCallId, text: item.planText, permissionRequestId: request.id },
      signal: plugin.lifetime.signal,
      profileId: action.profileId,
      navigation: {
        ...navigation,
        openAgent: (executorId) => {
          navigateToAgent({ serverId, agentId: executorId, workspaceId: item.workspaceId });
        },
      },
    });
  } finally {
    clearInterval(progress);
  }
}
