import type { PluginClientContext, PluginPlanActionContext } from "@getpaseo/plugin/client";
import { handoffToProfileRpc, reviewRpc } from "../shared/rpc";
import { profileId } from "../shared/profiles";

function planInput(context: PluginPlanActionContext) {
  return {
    workspaceId: context.workspace.id,
    agentId: context.agent.id,
    permissionRequestId: context.plan.permissionRequestId,
    callId: context.plan.callId,
    text: context.plan.text,
  };
}

export function registerActions(client: Pick<PluginClientContext, "addPlanAction">) {
  // COMPAT(workflow-plan-actions): added in v0.8.0, remove after 2027-09-13.
  if (typeof client.addPlanAction !== "function")
    throw new Error("Update the Paseo app to use workflow plan actions.");
  client.addPlanAction({
    id: "review",
    title: "Revue",
    order: 10,
    query: { launchProfileId: profileId("planner") },
    async onPress(context) {
      await context.rpc(reviewRpc, planInput(context));
    },
  });
  client.addPlanAction({
    id: "handoff",
    title: "Handoff",
    order: 20,
    requiresAgentProfile: true,
    async onPress(context) {
      // COMPAT(workflow-plan-action-signal): added in v0.9.1, remove after 2027-09-15.
      if (!context.signal) throw new Error("Update the Paseo app to hand off this plan.");
      if (!context.profileId) throw new Error("Choose an agent profile to hand off this plan.");
      const { agentId } = await context.rpc(handoffToProfileRpc, {
        ...planInput(context),
        profileId: context.profileId,
      });
      if (!agentId || context.signal.aborted) return;
      if (context.navigation?.replaceAgent) context.navigation.replaceAgent({ agentId });
      else context.navigation?.openAgent({ agentId });
    },
  });
}
