import { expect, test } from "vitest";
import type {
  PluginPlanActionContribution,
  PluginPlanActionContext,
} from "@getpaseo/plugin/client";
import { registerActions } from "./actions";

test("the client contributes Revue and Hand off with the exact live plan context and waits before opening the choice panel", async () => {
  const actions: PluginPlanActionContribution[] = [];
  registerActions({
    addPlanAction: (action) => {
      actions.push(action);
      return () => {};
    },
  });
  expect(actions.map((action) => action.title)).toEqual(["Revue", "Hand off"]);
  expect(
    actions.every((action) => action.query?.launchProfileId === "paseo-workflow-planner"),
  ).toBe(true);
  const calls: unknown[] = [];
  const context = {
    agent: { id: "agent" },
    workspace: { id: "workspace" },
    plan: { callId: "call", permissionRequestId: "permission", text: "Exact plan", turnId: "turn" },
    rpc: async (contract: { name: string }, input: unknown) => {
      calls.push({ rpc: contract.name, input });
      return {};
    },
    openPanel: (id: string) => {
      calls.push({ panel: id });
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
    { rpc: "workflow.handoff.prepare.request", input: expected },
    { panel: "workflow" },
  ]);
});
