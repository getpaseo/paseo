import { expect, test } from "vitest";
import type {
  PluginPlanActionContribution,
  PluginPlanActionContext,
} from "@getpaseo/plugin/client";
import { registerActions } from "./actions";

test("the client contributes Revue and one direct automatic Handoff", async () => {
  const actions: PluginPlanActionContribution[] = [];
  registerActions({
    addPlanAction: (action) => {
      actions.push(action);
      return () => {};
    },
  });
  expect(actions.map((action) => action.title)).toEqual(["Revue", "Handoff"]);
  expect(actions[0]?.query?.launchProfileId).toBe("paseo-workflow-planner");
  expect(actions[1]?.query).toBeUndefined();
  expect(actions[1]?.choices).toBeUndefined();
  const calls: unknown[] = [];
  const context = {
    agent: { id: "agent" },
    workspace: { id: "workspace" },
    plan: { callId: "call", permissionRequestId: "permission", text: "Exact plan", turnId: "turn" },
    rpc: async (contract: { name: string }, input: unknown) => {
      calls.push({ rpc: contract.name, input });
      if (contract.name === "workflow.plan.handoff.request") return { agentId: "executor" };
      return {};
    },
    navigation: {
      openAgent: ({ agentId }: { agentId: string }) => calls.push({ agentId }),
    },
  } as unknown as PluginPlanActionContext;
  await actions[0].onPress(context);
  await actions[1].onPress(context);
  const expected = {
    workspaceId: "workspace",
    agentId: "agent",
    permissionRequestId: "permission",
    callId: "call",
    text: "Exact plan",
  };
  expect(calls).toEqual([
    { rpc: "workflow.plan.review.request", input: expected },
    { rpc: "workflow.plan.handoff.request", input: expected },
    { agentId: "executor" },
  ]);
});
