import { afterEach, expect, test } from "vitest";
import { HubRelationshipHarness } from "./test-utils/relationship-harness.js";

let relationship: HubRelationshipHarness | null = null;

afterEach(async () => {
  await relationship?.close();
  relationship = null;
});

async function launchRelationship(): Promise<HubRelationshipHarness> {
  const launched = await HubRelationshipHarness.start();
  await launched.beginConnect().result;
  launched.connectLatestSocket();
  relationship = launched;
  return launched;
}

test("sequential replay after reconstruction keeps one durable owned agent", async () => {
  const hub = await launchRelationship();
  const created = await hub.createOwnedConcurrently();

  const reconstructed = await hub.reconstructAndReplay();

  expect(reconstructed.replay.agent.id).toBe(created.first.agentId);
  expect(reconstructed.replay.agent.status).toBe("closed");
  expect(reconstructed.durableAgentCount).toBe(1);
});

test("removing a daemon-owned agent removes its execution association", async () => {
  const hub = await launchRelationship();
  const created = await hub.createOwnedConcurrently();

  const removed = await hub.removeOwnedAgent(created.first.agentId);

  expect(removed.durableAgentCount).toBe(0);
});

test("a failed Hub create removes its auto-created worktree", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("failed-worktree-create", "failed-worktree-execution", {
    modeId: "missing-mode",
    worktree: { mode: "branch-off", newBranch: "failed-hub-create" },
  });

  const response = await hub.ownedCreateResult("failed-worktree-create");

  expect(response).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: { success: false, executionId: "failed-worktree-execution" },
  });
  expect(await hub.listedWorktrees()).toHaveLength(1);
  expect(await hub.durableOwnedAgentIds()).toEqual([]);
});

test("failed Hub auto-archive creates release their lifecycle subscriptions", async () => {
  const hub = await launchRelationship();
  const subscriptionBaseline = hub.agentSubscriptionCount();

  hub.failProviderPromptStart();
  hub.beginOwnedCreate("failed-prompt-create-1", "failed-prompt-execution-1", {
    autoArchive: true,
    worktree: { mode: "branch-off", newBranch: "failed-prompt-1" },
  });
  const first = await hub.ownedCreateResult("failed-prompt-create-1");

  expect(first).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: { success: false, executionId: "failed-prompt-execution-1" },
  });
  expect(hub.activeOwnedAgentIds()).toEqual([]);
  expect(await hub.durableOwnedAgentIds()).toEqual([]);
  expect(await hub.listedWorktrees()).toHaveLength(1);
  expect(hub.agentSubscriptionCount()).toBe(subscriptionBaseline);

  hub.failProviderPromptStart();
  hub.beginOwnedCreate("failed-prompt-create-2", "failed-prompt-execution-2", {
    autoArchive: true,
    worktree: { mode: "branch-off", newBranch: "failed-prompt-2" },
  });
  const second = await hub.ownedCreateResult("failed-prompt-create-2");

  expect(second).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: { success: false, executionId: "failed-prompt-execution-2" },
  });
  expect(hub.activeOwnedAgentIds()).toEqual([]);
  expect(await hub.durableOwnedAgentIds()).toEqual([]);
  expect(await hub.listedWorktrees()).toHaveLength(1);
  expect(hub.agentSubscriptionCount()).toBe(subscriptionBaseline);
});

test("failed Hub create cleans durable state when provider close rejects", async () => {
  const hub = await launchRelationship();
  hub.failProviderPromptStart();
  hub.failNextProviderSessionClose();
  hub.beginOwnedCreate("failed-close-create", "failed-close-execution", {
    worktree: { mode: "branch-off", newBranch: "failed-close-worktree" },
  });

  const response = await hub.ownedCreateResult("failed-close-create");

  expect(response).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: { success: false, executionId: "failed-close-execution" },
  });
  expect(hub.activeOwnedAgentIds()).toEqual([]);
  expect(await hub.durableOwnedAgentIds()).toEqual([]);
  expect(await hub.listedWorktrees()).toHaveLength(1);
});

test("Hub checkout uses the requested branch ref", async () => {
  const hub = await launchRelationship();
  await hub.createBranch("existing-hub-branch");
  hub.beginOwnedCreate("checkout-create", "checkout-execution", {
    worktree: { mode: "checkout-branch", branch: "existing-hub-branch" },
  });

  const response = await hub.ownedCreateResult("checkout-create");

  expect(response).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: { success: true, executionId: "checkout-execution" },
  });
  expect(await hub.currentBranch(hub.latestCreatedCwd()!)).toBe("existing-hub-branch");
});

test("failed create never archives a reused worktree", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("original-create", "original-execution", {
    worktree: { mode: "branch-off", newBranch: "shared-hub-worktree" },
  });
  const original = await hub.ownedCreateResult("original-create");
  const worktreeCwd = original.payload.agent?.cwd;
  expect(worktreeCwd).toEqual(expect.any(String));
  await hub.ownedTurnCompletion(original.payload.agentId!);

  const failedPrompt = "Fail the reused worktree create";
  hub.failProviderPromptStart(failedPrompt);
  hub.beginOwnedCreate("reused-create", "reused-execution", {
    autoArchive: true,
    prompt: failedPrompt,
    worktree: { mode: "branch-off", newBranch: "shared-hub-worktree" },
  });
  const reused = await hub.ownedCreateResult("reused-create");

  expect(reused).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: { success: false, executionId: "reused-execution" },
  });
  expect(await hub.worktreeState(worktreeCwd!)).toEqual({ exists: true, listed: true });
});
