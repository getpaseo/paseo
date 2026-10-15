import { expect, test } from "vitest";
import type {
  PluginPlanActionContribution,
  PluginPlanActionContext,
} from "@getpaseo/plugin/client";
import { registerActions } from "./actions";

test("the client contributes Revue and an explicit profile Handoff", async () => {
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
  expect(actions[1]?.requiresAgentProfile).toBe(true);
  expect(actions[1]?.onAvailable).toBeUndefined();
  const calls: unknown[] = [];
  const context = {
    signal: new AbortController().signal,
    profileId: "custom-profile",
    agent: { id: "agent" },
    workspace: { id: "workspace" },
    plan: { callId: "call", permissionRequestId: "permission", text: "Exact plan", turnId: "turn" },
    rpc: async (contract: { name: string }, input: unknown) => {
      calls.push({ rpc: contract.name, input });
      return { agentId: "executor" };
    },
    navigation: {
      openAgent: ({ agentId }: { agentId: string }) => calls.push({ agentId }),
      replaceAgent: ({ agentId }: { agentId: string }) => calls.push({ replacedAgentId: agentId }),
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
    {
      rpc: "workflow.plan.handoff_to_profile.request",
      input: { ...expected, profileId: "custom-profile" },
    },
    { replacedAgentId: "executor" },
  ]);
});

test("handoff requires an explicit profile before sending anything", async () => {
  const actions: PluginPlanActionContribution[] = [];
  registerActions({
    addPlanAction: (action) => {
      actions.push(action);
      return () => {};
    },
  });
  const rpc = async () => {
    throw new Error("must not send");
  };
  await expect(
    actions[1].onPress({
      signal: new AbortController().signal,
      rpc,
    } as unknown as PluginPlanActionContext),
  ).rejects.toThrow("Choose an agent profile");
});

test("an older host is rejected before the handoff is enqueued", async () => {
  const actions: PluginPlanActionContribution[] = [];
  registerActions({
    addPlanAction: (action) => {
      actions.push(action);
      return () => {};
    },
  });
  const calls: string[] = [];
  const context = {
    agent: { id: "agent" },
    workspace: { id: "workspace" },
    plan: { callId: "call", permissionRequestId: "permission", text: "Exact plan" },
    rpc: async (contract: { name: string }) => {
      calls.push(contract.name);
      return {};
    },
  } as unknown as PluginPlanActionContext;

  await expect(actions[1].onPress(context)).rejects.toThrow("Update the Paseo app");
  expect(calls).toEqual([]);
});
