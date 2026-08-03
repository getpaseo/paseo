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

test("Hub MCP configuration reaches the provider alongside Paseo MCP without entering snapshots", async () => {
  const hub = await HubRelationshipHarness.startWithAgentMcp();
  await hub.beginConnect().result;
  hub.connectLatestSocket();
  relationship = hub;
  const bearer = "hub-execution-bearer";
  hub.beginOwnedCreate("mcp-create", "mcp-execution", {
    providerOptions: {
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: { writable_roots: ["/var/cache/private-build"] },
    },
    mcpServers: {
      hub: {
        type: "http",
        url: "https://hub.test/mcp/executions/mcp-execution",
        headers: { Authorization: `Bearer ${bearer}` },
      },
    },
    toolPolicy: {
      preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }],
    },
  });

  const response = await hub.ownedCreateResult("mcp-create");

  expect(response).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: { success: true, agent: { provider: "codex" }, error: null },
  });
  expect(hub.latestProviderCreateConfig()?.mcpServers).toMatchObject({
    paseo: { type: "http" },
    hub: {
      type: "http",
      url: "https://hub.test/mcp/executions/mcp-execution",
      headers: { Authorization: `Bearer ${bearer}` },
    },
  });
  expect(hub.latestProviderCreateConfig()?.providerOptions).toEqual({
    sandbox_mode: "workspace-write",
    sandbox_workspace_write: { writable_roots: ["/var/cache/private-build"] },
  });
  expect(hub.latestProviderCreateConfig()?.toolPolicy).toEqual({
    preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }],
  });
  expect(response.payload.agent).not.toHaveProperty("config");
  expect(response.payload.agent).not.toHaveProperty("mcpServers");
  expect(response.payload.agent.persistence?.metadata).toEqual({
    conversationId: response.payload.agent.persistence?.sessionId,
    cwd: response.payload.agent.cwd,
  });
  expect(JSON.stringify(response.payload.agent)).not.toContain(bearer);
  expect(JSON.stringify(response.payload.agent)).not.toContain("private-build");
  expect(JSON.stringify(response.payload.agent)).not.toContain("finish_execution");

  const update = hub.hubMessages().find((message) => message.type === "hub.execution.agent.update");
  expect(update).toMatchObject({
    type: "hub.execution.agent.update",
    payload: { agent: { provider: "codex" } },
  });
  if (!update || update.type !== "hub.execution.agent.update") {
    throw new Error("Expected a Hub execution agent update");
  }
  expect(update.payload.agent).not.toHaveProperty("config");
  expect(update.payload.agent).not.toHaveProperty("mcpServers");
  expect(update.payload.agent.persistence?.metadata).toEqual({
    conversationId: update.payload.agent.persistence?.sessionId,
    cwd: update.payload.agent.cwd,
  });
  expect(JSON.stringify(update.payload.agent)).not.toContain(bearer);
  expect(JSON.stringify(update.payload.agent)).not.toContain("private-build");
  expect(JSON.stringify(update.payload.agent)).not.toContain("finish_execution");
});

test("Hub can preapprove only tools on MCP servers injected in the same request", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("foreign-grant", "foreign-grant-execution", {
    mcpServers: {
      hub: { type: "http", url: "https://hub.test/mcp/executions/foreign-grant" },
    },
    toolPolicy: {
      preapproved: [{ kind: "mcp", server: "unrelated", tool: "dangerous_tool" }],
    },
  });

  const response = await hub.ownedCreateResult("foreign-grant");

  expect(response).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: {
      success: false,
      agentId: null,
      error: {
        code: "create_failed",
        message: expect.stringContaining("requires MCP server 'unrelated'"),
      },
    },
  });
  expect(hub.providerCreations()).toBe(0);
});

test("Hub returns path-specific structured provider option feedback", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("invalid-options", "invalid-options-execution", {
    providerOptions: {
      sandbox_workspace_write: { writable_roots: ["/tmp", 42] },
    },
  });

  const response = await hub.ownedCreateResult("invalid-options");

  expect(response).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: {
      success: false,
      error: {
        code: "provider_options_invalid",
        provider: "codex",
        issues: [
          {
            path: ["sandbox_workspace_write", "writable_roots", 1],
            message: expect.any(String),
          },
        ],
      },
    },
  });
});

test("new Hub executions cannot override the daemon-owned Paseo MCP server", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("reserved-mcp-create", "reserved-mcp-execution", {
    mcpServers: {
      paseo: { type: "http", url: "https://hub.test/replace-paseo" },
    },
  });

  const response = await hub.ownedCreateResult("reserved-mcp-create");

  expect(response).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: {
      success: false,
      executionId: "reserved-mcp-execution",
      agentId: null,
      agent: null,
    },
  });
  expect(hub.providerCreations()).toBe(0);
  expect(hub.activeOwnedAgentIds()).toEqual([]);
  expect(await hub.durableOwnedAgentIds()).toEqual([]);
});

test("reserved Paseo MCP input does not invalidate replay of an owned execution", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("original-create", "replayed-execution");
  const original = await hub.ownedCreateResult("original-create");
  expect(original).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: { success: true, executionId: "replayed-execution" },
  });
  const providerCreations = hub.providerCreations();

  hub.beginOwnedCreate("replay-create", "replayed-execution", {
    mcpServers: {
      paseo: { type: "http", url: "https://hub.test/replace-paseo" },
    },
  });
  const replay = await hub.ownedCreateResult("replay-create");

  expect(replay).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: {
      success: true,
      executionId: "replayed-execution",
      agentId: original.payload.agentId,
    },
  });
  expect(hub.providerCreations()).toBe(providerCreations);
  expect(await hub.durableOwnedAgentIds()).toEqual([original.payload.agentId]);
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

test("failed Hub creates release their lifecycle subscriptions", async () => {
  const hub = await launchRelationship();
  const subscriptionBaseline = hub.agentSubscriptionCount();

  hub.failProviderPromptStart();
  hub.beginOwnedCreate("failed-prompt-create-1", "failed-prompt-execution-1", {
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
  hub.beginOwnedCreate("failed-prompt-create-2", "failed-prompt-execution-2");
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

test("finishing an execution preserves a workspace being acquired by a rival", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("first-create", "first-execution", {
    worktree: { mode: "branch-off", newBranch: "shared-finish-worktree" },
  });
  const first = await hub.ownedCreateResult("first-create");
  const worktreeCwd = first.payload.agent?.cwd;
  const workspaceId = first.payload.agent?.workspaceId;
  expect(worktreeCwd).toEqual(expect.any(String));
  expect(workspaceId).toEqual(expect.any(String));

  const priorProviderCreations = hub.providerCreations();
  hub.holdAgentCreationAtCwd(worktreeCwd!);
  const rivalCreation = hub.createAgentInWorkspace(workspaceId!, worktreeCwd!);

  let archiveResult;
  try {
    await hub.agentCreationAtCwd(worktreeCwd!, priorProviderCreations);
    archiveResult = await hub.archiveExecution("first-execution");
  } finally {
    hub.finishAgentCreation();
  }
  const rival = await rivalCreation;

  expect(archiveResult).toMatchObject({ success: true, executionId: "first-execution" });
  expect(rival.workspaceId).toBe(workspaceId);
  expect(await hub.ownedAgentArchivedAt(first.payload.agentId!)).not.toBeNull();
  expect(await hub.agentRemainsAvailable(rival.id)).toBe(true);
  expect(await hub.worktreeState(worktreeCwd!)).toEqual({ exists: true, listed: true });
});
