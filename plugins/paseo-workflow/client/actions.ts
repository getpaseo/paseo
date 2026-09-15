import type { PluginClientContext, PluginPlanActionContext } from "@getpaseo/plugin/client";
import { handoffRpc, reviewRpc } from "../shared/rpc";
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
    async onPress(context) {
      const { agentId } = await context.rpc(handoffRpc, planInput(context));
      context.navigation?.openAgent({ agentId });
    },
  });
}
