import type { PluginServerContext } from "@getpaseo/plugin/server";
import { installRpc, reviewRpc, handoffRpc, prepareRpc, statusRpc } from "./shared/rpc";
import { profileId } from "./shared/profiles";
import { installProfiles } from "./server/install";
import { workflowSettings } from "./server/state";
import { runtime, prepareAgent } from "./server/runtime";
import type { PaseoApi } from "./server/types";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(workflowSettings);
  // COMPAT(workflow-server-settings): added in v0.8.0, remove after 2027-09-13.
  if (!settings) throw new Error("Update the Paseo host to use the plan workflow plugin.");
  let controller: ReturnType<typeof runtime> | undefined;
  const workflow = (paseo: PaseoApi) => (controller ??= runtime(paseo, settings));
  server.handle(installRpc, async (_, { paseo }) => ({
    type: "workflow.profiles.install.response" as const,
    count: (await installProfiles(paseo.config)).config.agentProfiles?.length ?? 0,
  }));
  server.handle(reviewRpc, async (input, { paseo }) => ({
    type: "workflow.plan.review.response" as const,
    ...(await workflow(paseo).review(input, "manual")),
  }));
  server.handle(prepareRpc, async (input, { paseo }) => ({
    type: "workflow.handoff.prepare.response" as const,
    ...(await workflow(paseo).prepareHandoff(input)),
  }));
  server.handle(handoffRpc, async ({ selection: _ignored, ...context }, { paseo }) => ({
    type: "workflow.plan.handoff.response" as const,
    ...(await workflow(paseo).handoff(context)),
  }));
  server.handle(statusRpc, async (input, { paseo }) => ({
    type: "workflow.status.get.response" as const,
    ...(await workflow(paseo).status(input.agentId, input.workspaceId)),
  }));
  server.before("agent.create", ({ request }, { paseo }) => prepareAgent(request, paseo));
  server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => {
    if (
      agent.launchProfileId !== profileId("planner") ||
      request.kind !== "plan" ||
      !request.sourcePlanCallId ||
      !agent.workspaceId
    )
      return;
    const text = request.input?.plan ?? request.metadata?.planText;
    if (typeof text !== "string") throw new Error("The pending plan has no canonical text.");
    await workflow(paseo).planRequested(
      {
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        permissionRequestId: request.id,
        callId: request.sourcePlanCallId,
        text,
      },
      request.metadata?.syntheticPlan !== true,
    );
  });
  server.on("agent.permission_resolved", async ({ agent, requestId, resolution }, { paseo }) => {
    if (agent.launchProfileId === profileId("planner") && resolution.behavior === "allow")
      await workflow(paseo).approved(agent.id, requestId);
  });
  server.on("agent.turn_ended", async ({ agent, outcome, turnId }, { paseo }) => {
    if (outcome.kind !== "completed") return;
    // Direct-config executors have no workflow launch profile; trust only the executor role labels.
    const roles = [
      "executor-trivial",
      "executor-bounded",
      "executor-diagnostic",
      "executor-complex",
      "executor-critical",
    ];
    const admitted =
      agent.launchProfileId?.startsWith("paseo-workflow-") ||
      roles.includes(agent.labels["paseo.workflow.role"] ?? "");
    if (!admitted) return;
    await workflow(paseo).turnEnded(agent.id, turnId);
  });
  return () => {};
}
