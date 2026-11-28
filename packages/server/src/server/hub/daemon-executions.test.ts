import { existsSync } from "node:fs";
import path from "node:path";
import type { SessionOutboundMessage } from "../messages.js";
import type { AgentClient } from "../agent/agent-sdk-types.js";
import { UNATTENDED_HUB_PERMISSION_DENY_MESSAGE } from "../agent/unattended-permission-policy.js";
import { validateProviderOptions } from "../agent/provider-options.js";
import { CodexProviderOptionsSchema } from "../agent/providers/codex/options.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { afterEach, expect, test } from "vitest";
import { HubRelationshipHarness } from "./test-utils/relationship-harness.js";

let relationship: HubRelationshipHarness | null = null;

afterEach(async () => {
  await relationship?.close();
  relationship = null;
});

async function launchRelationship(
  clients?: Record<string, AgentClient>,
): Promise<HubRelationshipHarness> {
  const launched = clients
    ? await HubRelationshipHarness.startWithRealAgentClients(clients)
    : await HubRelationshipHarness.start();
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
  // Provider options are not secret and appear in the snapshot's `options`.
  expect(response.payload.agent.options).toMatchObject({
    sandbox_workspace_write: { writable_roots: ["/var/cache/private-build"] },
  });
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

test("Hub returns path-specific feedback thrown by the provider", async () => {
  const clients = createTestAgentClients();
  const inner = clients.codex;
  const provider: AgentClient = {
    provider: inner.provider,
    capabilities: inner.capabilities,
    isAvailable: (signal, options) => inner.isAvailable(signal, options),
    fetchCatalog: (options, context) => inner.fetchCatalog(options, context),
    async createSession(config, launch, options) {
      validateProviderOptions("codex", CodexProviderOptionsSchema, config.providerOptions);
      return inner.createSession(config, launch, options);
    },
    resumeSession: (handle, overrides, launch, options) =>
      inner.resumeSession(handle, overrides, launch, options),
  };
  const hub = await launchRelationship({ ...clients, codex: provider });
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
  const executionProviderCreations = hub.executionProviderCreations();

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
  expect(hub.executionProviderCreations()).toBe(executionProviderCreations);
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

function hasAutoDeniedPermissionEvent(
  messages: readonly SessionOutboundMessage[],
  agentId: string,
): boolean {
  return messages.some(
    (message) =>
      message.type === "agent_permission_resolved" &&
      message.payload.agentId === agentId &&
      message.payload.resolution.behavior === "deny" &&
      message.payload.resolution.message === UNATTENDED_HUB_PERMISSION_DENY_MESSAGE,
  );
}

function hasPermissionRequestEvent(
  messages: readonly SessionOutboundMessage[],
  agentId: string,
): boolean {
  return messages.some(
    (message) => message.type === "agent_permission_request" && message.payload.agentId === agentId,
  );
}

test("Hub-dispatched root executions and MCP-spawned subagents auto-deny unexpected permission prompts while interactive agents stay pending", async () => {
  const hub = await HubRelationshipHarness.startWithAgentMcp();
  await hub.beginConnect().result;
  hub.connectLatestSocket();
  relationship = hub;

  const rootTargetFile = path.join(hub.repoRoot(), "hub-root-blocked.txt");
  const interactiveTargetFile = path.join(hub.repoRoot(), "interactive-approved.txt");

  await hub.withTrustedClient(async (client) => {
    await client.fetchAgents({ subscribe: {} });
    const observedEvents: SessionOutboundMessage[] = [];
    const permissionObservation = client.observeEvents([
      "agent_permission_request",
      "agent_permission_resolved",
      "agent_attention_required",
    ]);
    const stopObserving = permissionObservation.subscribe({
      snapshot: () => {},
      update: (message) => {
        observedEvents.push(message);
      },
    });
    await permissionObservation.ready;
    try {
      // 1. Root Hub-dispatched execution raises a tool permission prompt -> auto-denied immediately.
      hub.beginOwnedCreate("hub-root-perm", "hub-root-perm-exec", {
        modeId: "default",
        prompt: 'Request approval to run the command `printf "ok" > hub-root-blocked.txt`.',
      });
      const rootCreate = await hub.ownedCreateResult("hub-root-perm");
      expect(rootCreate).toMatchObject({
        type: "hub.execution.agent.create.response",
        payload: { success: true, executionId: "hub-root-perm-exec" },
      });
      if (
        rootCreate.type !== "hub.execution.agent.create.response" ||
        !rootCreate.payload.agentId
      ) {
        throw new Error("Expected Hub root agent id");
      }
      const rootAgentId = rootCreate.payload.agentId;

      await hub.ownedTurnCompletion(rootAgentId);
      expect(existsSync(rootTargetFile)).toBe(false);

      const rootStreamEvents = hub.ownedStreamEvents(rootAgentId);
      expect(rootStreamEvents.some((event) => event.type === "permission_requested")).toBe(false);
      expect(rootStreamEvents).toContainEqual(
        expect.objectContaining({
          type: "permission_resolved",
          resolution: {
            behavior: "deny",
            message: UNATTENDED_HUB_PERMISSION_DENY_MESSAGE,
          },
        }),
      );

      // 2. Delegated subagent spawned by the Hub-dispatched root via Paseo MCP -> also auto-denied immediately.
      const { agentId: childAgentId } = await hub.spawnSubagentViaLatestMcp({
        provider: "codex/gpt-5.4",
        title: "Hub reviewer subagent",
        modeId: "default",
        notifyOnFinish: true,
        initialPrompt: "Run echo hello",
      });

      const childFinish = await client.waitForFinish(childAgentId, 5_000);
      expect(childFinish.status).toBe("idle");
      expect(childFinish.final?.pendingPermissions ?? []).toEqual([]);

      await expect
        .poll(() => hasAutoDeniedPermissionEvent(observedEvents, childAgentId))
        .toBe(true);

      // Neither the Hub root nor its subagent should emit interactive permission prompts or permission attention.
      const hubPermissionPrompts = observedEvents.filter(
        (message) =>
          message.type === "agent_permission_request" &&
          (message.payload.agentId === rootAgentId || message.payload.agentId === childAgentId),
      );
      expect(hubPermissionPrompts).toEqual([]);
      const hubPermissionAttention = observedEvents.filter(
        (message) =>
          message.type === "agent_attention_required" &&
          message.payload.reason === "permission" &&
          (message.payload.agentId === rootAgentId || message.payload.agentId === childAgentId),
      );
      expect(hubPermissionAttention).toEqual([]);

      // 3. Normal interactive user agent on the exact same daemon still waits for human approval.
      const interactiveAgent = await client.createAgent({
        provider: "codex",
        cwd: hub.repoRoot(),
        title: "Interactive User Agent",
        modeId: "default",
      });
      await client.sendMessage(
        interactiveAgent.id,
        'Request approval to run the command `printf "ok" > interactive-approved.txt`.',
      );
      const pendingState = await client.waitForFinish(interactiveAgent.id, 5_000);
      expect(pendingState.status).toBe("permission");
      expect(pendingState.final?.pendingPermissions).toHaveLength(1);
      await expect
        .poll(() => hasPermissionRequestEvent(observedEvents, interactiveAgent.id))
        .toBe(true);

      await client.respondToPermission(
        interactiveAgent.id,
        pendingState.final!.pendingPermissions[0]!.id,
        { behavior: "allow" },
      );
      const interactiveFinal = await client.waitForFinish(interactiveAgent.id, 5_000);
      expect(interactiveFinal.status).toBe("idle");
      expect(existsSync(interactiveTargetFile)).toBe(true);
    } finally {
      stopObserving();
      await permissionObservation.release();
    }
  });
});
