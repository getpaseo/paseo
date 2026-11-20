import { describe, expect, it } from "vitest";
import {
  AgentCreatedStatusPayloadSchema,
  AgentCreateResponseSchema,
  AgentCreationUpdateSchema,
  AgentListMessageSchema,
  AgentResumedStatusPayloadSchema,
  AgentStatusMessageSchema,
  AgentUpdateMessageSchema,
  CancelAgentResponseMessageSchema,
  ClearAgentAttentionResponseMessageSchema,
  CreationSubscribeResponseSchema,
  FetchAgentHistoryResponseMessageSchema,
  FetchAgentResponseMessageSchema,
  FetchAgentsResponseMessageSchema,
  FetchAgentTimelineResponseMessageSchema,
  HubExecutionAgentCreateResponseSchema,
  HubExecutionAgentUpdateSchema,
  PluginRpcEventSchema,
  PluginRpcInvokeResponseSchema,
  SetAgentTimelineSubscriptionResponseMessageSchema,
  StatusMessageSchema,
  WaitForFinishResponseMessageSchema,
  WorkspaceCreateResponseSchema,
  WorkspaceCreationUpdateSchema,
} from "@getpaseo/protocol/messages";
import type { PluginConfigAdoptions } from "@getpaseo/protocol/plugin-agent-config";

import { AGENT_LIFECYCLE_STATUSES } from "./agent-manager.js";
import {
  attachAgentCopySafeOptions,
  buildStoredAgentPayload,
  mapAgentSnapshotEnvelopes,
  readAgentCopySafeOptions,
  toAgentPayload,
  toAgentListItemPayload,
  toRecentProviderSessionDescriptorPayload,
  toStoredAgentRecord,
  type ManagedAgent,
} from "./agent-projections.js";
import type { AgentSession } from "./agent-sdk-types.js";
import type {
  AgentOptionControl,
  ImportableProviderSession,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentSessionConfig,
} from "./agent-sdk-types.js";

/** A provider with no defaults of its own: the effective options are the agent's own. */
const ownOptionsOnly = (_provider: string, own: Record<string, unknown> | undefined) => own ?? {};

type ManagedAgentOverrides = Omit<Partial<ManagedAgent>, "config" | "pendingPermissions"> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
};

function createManagedAgent(overrides: ManagedAgentOverrides = {}): ManagedAgent {
  const now = new Date("2025-01-01T00:00:00.000Z");
  const baseConfig: AgentSessionConfig = {
    provider: "claude",
    cwd: "/tmp/project",
    modeId: "plan",
    model: "claude-3.5-sonnet",
    providerOptions: { allowedTools: ["Read"] },
  };

  const basePersistence: AgentPersistenceHandle = {
    provider: "claude",
    sessionId: "persist-1",
    metadata: { branch: "feature/refactor" },
  };

  const configOverrides = overrides.config ?? {};
  const {
    config: _ignoredConfig,
    pendingPermissions: pendingPermissionsOverride,
    lifecycle = "idle",
    ...restOverrides
  } = overrides;

  const sessionValue =
    lifecycle === "closed" ? null : (restOverrides.session ?? ({} as AgentSession));
  const activeForegroundTurnIdValue =
    restOverrides.activeForegroundTurnId ?? (lifecycle === "running" ? "test-turn-id" : null);
  const lastErrorValue =
    restOverrides.lastError ?? (lifecycle === "error" ? "encountered error" : undefined);

  const agent: ManagedAgent = {
    id: "agent-123",
    provider: "claude",
    cwd: "/tmp/project",
    session: sessionValue,
    sessionId: "session-123",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    config: { ...baseConfig, ...configOverrides },
    lifecycle,
    createdAt: now,
    updatedAt: now,
    availableModes: [
      { id: "plan", label: "Planning" },
      { id: "build", label: "Building", description: "Detailed" },
    ],
    currentModeId: "plan",
    pendingPermissions: pendingPermissionsOverride ?? new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId: activeForegroundTurnIdValue,
    activeTurnId: activeForegroundTurnIdValue,
    activeTurnStartedAt: lifecycle === "running" ? new Date("2025-01-01T00:00:01.000Z") : null,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: [],
    runtimeInfo: {
      provider: "claude",
      sessionId: "session-123",
      model: "claude-3.5-sonnet",
      modeId: "plan",
    },
    persistence: { ...basePersistence },
    lastUsage: undefined,
    lastError: lastErrorValue,
    historyPrimed: true,
    lastUserMessageAt: now,
    attention: { requiresAttention: false },
  };

  return {
    ...agent,
    ...restOverrides,
    lifecycle,
    config: agent.config,
    pendingPermissions: agent.pendingPermissions,
  };
}

it("projects the daemon-owned active turn identity", () => {
  expect(toAgentPayload(createManagedAgent({ lifecycle: "running" })).activeTurn).toEqual({
    turnId: "test-turn-id",
    startedAt: "2025-01-01T00:00:01.000Z",
  });
});

describe("mapAgentSnapshotEnvelopes", () => {
  const agent = toAgentPayload(createManagedAgent({ effectiveOptions: { view: "original" } }));
  const secondAgent = { ...agent, id: "agent-456" };
  const project = {
    projectKey: "project-1",
    projectName: "Project",
    checkout: {
      cwd: "/tmp/project",
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
  };
  const creation = {
    kind: "agent",
    idempotencyKey: "creation-1",
    revision: 1,
    phase: "agent_ready",
    workspaceId: null,
    agentId: "agent-123",
    agent,
    error: null,
  };

  it.each([
    {
      name: "status agent_created payload.agent",
      schema: StatusMessageSchema.extend({ payload: AgentCreatedStatusPayloadSchema }),
      input: {
        type: "status",
        payload: { status: "agent_created", requestId: "request-1", agentId: "agent-123", agent },
      },
      expected: { payload: { agent: { options: { view: "projected" } } } },
    },
    {
      name: "status agent_resumed payload.agent",
      schema: StatusMessageSchema.extend({ payload: AgentResumedStatusPayloadSchema }),
      input: {
        type: "status",
        payload: {
          status: "agent_resumed",
          requestId: "request-1",
          agentId: "agent-123",
          agent,
          timelineSize: 0,
        },
      },
      expected: { payload: { agent: { options: { view: "projected" } } } },
    },
    {
      name: "agent_update upsert payload.agent",
      schema: AgentUpdateMessageSchema,
      input: { type: "agent_update", payload: { kind: "upsert", agent } },
      expected: { payload: { agent: { options: { view: "projected" } } } },
    },
    {
      name: "agent_status payload.info",
      schema: AgentStatusMessageSchema,
      input: {
        type: "agent_status",
        payload: { agentId: "agent-123", status: "idle", info: agent },
      },
      expected: { payload: { info: { options: { view: "projected" } } } },
    },
    {
      name: "agent_list payload.agents array",
      schema: AgentListMessageSchema,
      input: { type: "agent_list", payload: { agents: [agent, secondAgent] } },
      expected: {
        payload: {
          agents: [
            { id: "agent-123", options: { view: "projected" } },
            { id: "agent-456", options: { view: "projected" } },
          ],
        },
      },
    },
    {
      name: "fetch_agents_response payload.entries[].agent",
      schema: FetchAgentsResponseMessageSchema,
      input: {
        type: "fetch_agents_response",
        payload: {
          requestId: "request-1",
          entries: [
            { agent, project },
            { agent: secondAgent, project },
          ],
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        },
      },
      expected: {
        payload: {
          entries: [
            { agent: { id: "agent-123", options: { view: "projected" } } },
            { agent: { id: "agent-456", options: { view: "projected" } } },
          ],
        },
      },
    },
    {
      name: "fetch_agent_history_response payload.entries[].agent",
      schema: FetchAgentHistoryResponseMessageSchema,
      input: {
        type: "fetch_agent_history_response",
        payload: {
          requestId: "request-1",
          entries: [
            { agent, project },
            { agent: secondAgent, project },
          ],
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        },
      },
      expected: {
        payload: {
          entries: [
            { agent: { id: "agent-123", options: { view: "projected" } } },
            { agent: { id: "agent-456", options: { view: "projected" } } },
          ],
        },
      },
    },
    {
      name: "fetch_agent_response payload.agent",
      schema: FetchAgentResponseMessageSchema,
      input: {
        type: "fetch_agent_response",
        payload: { requestId: "request-1", agent, project: null, error: null },
      },
      expected: { payload: { agent: { options: { view: "projected" } } } },
    },
    {
      name: "fetch_agent_timeline_response payload.agent",
      schema: FetchAgentTimelineResponseMessageSchema,
      input: {
        type: "fetch_agent_timeline_response",
        payload: {
          requestId: "request-1",
          agentId: "agent-123",
          agent,
          direction: "tail",
          projection: "projected",
          epoch: "epoch-1",
          reset: false,
          staleCursor: false,
          gap: false,
          window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
          startCursor: null,
          endCursor: null,
          hasOlder: false,
          hasNewer: false,
          entries: [],
          error: null,
        },
      },
      expected: { payload: { agent: { options: { view: "projected" } } } },
    },
    {
      name: "agent.timeline.set_subscription.response payload.agents record",
      schema: SetAgentTimelineSubscriptionResponseMessageSchema,
      input: {
        type: "agent.timeline.set_subscription.response",
        payload: {
          requestId: "request-1",
          agentIds: ["agent-123", "agent-456"],
          agents: { "agent-123": agent, "agent-456": secondAgent },
        },
      },
      expected: {
        payload: {
          agents: {
            "agent-123": { id: "agent-123", options: { view: "projected" } },
            "agent-456": { id: "agent-456", options: { view: "projected" } },
          },
        },
      },
    },
    {
      name: "cancel_agent_response payload.agent",
      schema: CancelAgentResponseMessageSchema,
      input: {
        type: "cancel_agent_response",
        payload: { requestId: "request-1", agentId: "agent-123", agent, error: null },
      },
      expected: { payload: { agent: { options: { view: "projected" } } } },
    },
    {
      name: "clear_agent_attention_response payload.agents array",
      schema: ClearAgentAttentionResponseMessageSchema,
      input: {
        type: "clear_agent_attention_response",
        payload: {
          requestId: "request-1",
          agentId: ["agent-123", "agent-456"],
          agents: [agent, secondAgent],
        },
      },
      expected: {
        payload: {
          agents: [
            { id: "agent-123", options: { view: "projected" } },
            { id: "agent-456", options: { view: "projected" } },
          ],
        },
      },
    },
    {
      name: "workspace.create.update payload.agent",
      schema: WorkspaceCreationUpdateSchema,
      input: { type: "workspace.create.update", payload: { ...creation, kind: "workspace" } },
      expected: { payload: { agent: { options: { view: "projected" } } } },
    },
    {
      name: "agent.create.update payload.agent",
      schema: AgentCreationUpdateSchema,
      input: { type: "agent.create.update", payload: creation },
      expected: { payload: { agent: { options: { view: "projected" } } } },
    },
    {
      name: "creation.subscribe.response payload.snapshot.agent",
      schema: CreationSubscribeResponseSchema,
      input: {
        type: "creation.subscribe.response",
        payload: { requestId: "request-1", snapshot: creation, error: null },
      },
      expected: { payload: { snapshot: { agent: { options: { view: "projected" } } } } },
    },
    {
      name: "agent.create.response payload.agent and payload.creation.agent",
      schema: AgentCreateResponseSchema,
      input: {
        type: "agent.create.response",
        payload: { requestId: "request-1", agent, creation, error: null },
      },
      expected: {
        payload: {
          agent: { options: { view: "projected" } },
          creation: { agent: { options: { view: "projected" } } },
        },
      },
    },
    {
      name: "workspace.create.response payload.agent and payload.creation.agent",
      schema: WorkspaceCreateResponseSchema,
      input: {
        type: "workspace.create.response",
        payload: {
          requestId: "request-1",
          agent,
          creation: { ...creation, kind: "workspace" },
          workspace: null,
          setupTerminalId: null,
          error: null,
        },
      },
      expected: {
        payload: {
          agent: { options: { view: "projected" } },
          creation: { agent: { options: { view: "projected" } } },
        },
      },
    },
    {
      name: "wait_for_finish_response payload.final",
      schema: WaitForFinishResponseMessageSchema,
      input: {
        type: "wait_for_finish_response",
        payload: {
          requestId: "request-1",
          status: "idle",
          final: agent,
          error: null,
          lastMessage: null,
        },
      },
      expected: { payload: { final: { options: { view: "projected" } } } },
    },
    {
      name: "hub.execution.agent.create.response payload.agent",
      schema: HubExecutionAgentCreateResponseSchema,
      input: {
        type: "hub.execution.agent.create.response",
        payload: {
          requestId: "request-1",
          executionId: "execution-1",
          agentId: "agent-123",
          agent,
          success: true,
          error: null,
        },
      },
      expected: { payload: { agent: { options: { view: "projected" } } } },
    },
    {
      name: "hub.execution.agent.update payload.agent",
      schema: HubExecutionAgentUpdateSchema,
      input: {
        type: "hub.execution.agent.update",
        payload: { executionId: "execution-1", agentId: "agent-123", agent },
      },
      expected: { payload: { agent: { options: { view: "projected" } } } },
    },
  ])("projects schema-owned $name", ({ schema, input, expected }) => {
    const message = structuredClone(input);
    schema.parse(message);

    const projected = mapAgentSnapshotEnvelopes(message, (snapshot) => ({
      ...snapshot,
      options: { view: "projected" },
    }));

    expect(projected).toMatchObject(expected);
    expect(message).toEqual(input);
  });

  it.each([
    {
      name: "nullable agent",
      schema: FetchAgentResponseMessageSchema,
      input: {
        type: "fetch_agent_response",
        payload: { requestId: "request-1", agent: null, error: "Not found" },
      },
    },
    {
      name: "empty agent array",
      schema: AgentListMessageSchema,
      input: { type: "agent_list", payload: { agents: [] } },
    },
    {
      name: "empty directory entries",
      schema: FetchAgentsResponseMessageSchema,
      input: {
        type: "fetch_agents_response",
        payload: {
          requestId: "request-1",
          entries: [],
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        },
      },
    },
    {
      name: "absent agent record",
      schema: SetAgentTimelineSubscriptionResponseMessageSchema,
      input: {
        type: "agent.timeline.set_subscription.response",
        payload: { requestId: "request-1", agentIds: [] },
      },
    },
    {
      name: "empty agent record",
      schema: SetAgentTimelineSubscriptionResponseMessageSchema,
      input: {
        type: "agent.timeline.set_subscription.response",
        payload: { requestId: "request-1", agentIds: [], agents: {} },
      },
    },
    {
      name: "nullable creation snapshot",
      schema: CreationSubscribeResponseSchema,
      input: {
        type: "creation.subscribe.response",
        payload: { requestId: "request-1", snapshot: null, error: "Not found" },
      },
    },
    {
      name: "optional creation agent",
      schema: AgentCreationUpdateSchema,
      input: {
        type: "agent.create.update",
        payload: {
          kind: "agent",
          idempotencyKey: "creation-1",
          revision: 0,
          phase: "accepted",
          workspaceId: null,
          agentId: null,
          error: null,
        },
      },
    },
    {
      name: "nullable final agent",
      schema: WaitForFinishResponseMessageSchema,
      input: {
        type: "wait_for_finish_response",
        payload: {
          requestId: "request-1",
          status: "timeout",
          final: null,
          error: null,
          lastMessage: null,
        },
      },
    },
    {
      name: "removed agent update",
      schema: AgentUpdateMessageSchema,
      input: { type: "agent_update", payload: { kind: "remove", agentId: "agent-123" } },
    },
  ])("preserves schema-owned $name without projecting a snapshot", ({ schema, input }) => {
    const message = structuredClone(input);
    schema.parse(message);

    const projected = mapAgentSnapshotEnvelopes(message, () => {
      throw new Error("This envelope has no agent snapshot");
    });

    expect(projected).toEqual(input);
    expect(message).toEqual(input);
  });

  it.each([
    {
      name: "plugin RPC output",
      schema: PluginRpcInvokeResponseSchema,
      input: {
        type: "plugin.rpc.invoke.response",
        payload: {
          requestId: "request-1",
          output: { agent, info: agent, final: agent, agents: [agent] },
        },
      },
    },
    {
      name: "plugin subscription event",
      schema: PluginRpcEventSchema,
      input: {
        type: "plugin.rpc.event",
        payload: {
          subscriptionId: "subscription-1",
          event: { agent, snapshot: { agent }, creation: { agent }, entries: [{ agent }] },
        },
      },
    },
  ])("leaves arbitrary agent-shaped $name untouched", ({ schema, input }) => {
    const message = structuredClone(input);
    schema.parse(message);

    const projected = mapAgentSnapshotEnvelopes(message, () => {
      throw new Error("Plugin data is not a schema-owned agent snapshot");
    });

    expect(projected).toBe(message);
    expect(message).toEqual(input);
  });

  it("detaches projected snapshots without changing shared source payloads or opaque agent data", () => {
    const opaqueData = { agent, agents: [agent], snapshot: { agent }, creation: { agent } };
    const sharedAgent = {
      ...agent,
      metadata: { plugin: opaqueData },
      options: { plugin: opaqueData },
    };
    const message = {
      type: "agent.create.response",
      payload: {
        requestId: "request-1",
        agent: sharedAgent,
        creation: { ...creation, agent: sharedAgent },
        error: null,
      },
    };
    AgentCreateResponseSchema.parse(message);
    const otherClientMessage = {
      type: "fetch_agent_response",
      payload: { requestId: "request-other-client", agent: sharedAgent, error: null },
    };
    FetchAgentResponseMessageSchema.parse(otherClientMessage);

    const projected = mapAgentSnapshotEnvelopes(message, (snapshot) => ({
      ...snapshot,
      title: "Projected title",
    }));

    expect(projected.payload.agent.title).toBe("Projected title");
    expect(projected.payload.creation.agent.title).toBe("Projected title");
    expect(projected.payload.agent).not.toBe(sharedAgent);
    expect(projected.payload.creation).not.toBe(message.payload.creation);
    expect(message.payload.agent).toBe(sharedAgent);
    expect(message.payload.creation.agent).toBe(sharedAgent);
    expect(otherClientMessage.payload.agent.title).toBeNull();
    expect(sharedAgent.title).toBeNull();
    expect(projected.payload.agent.metadata?.plugin).toBe(opaqueData);
    expect(projected.payload.agent.options?.plugin).toBe(opaqueData);
    expect(opaqueData.agent.options).toEqual({ view: "original" });
    expect(opaqueData.agents[0].options).toEqual({ view: "original" });
    expect(opaqueData.snapshot.agent.options).toEqual({ view: "original" });
    expect(opaqueData.creation.agent.options).toEqual({ view: "original" });
  });
});

function createPermission(overrides: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
  const base: AgentPermissionRequest = {
    id: "perm-1",
    provider: "claude",
    name: "execute_command",
    kind: "tool",
    title: "Run command",
    description: "Execute shell command",
    input: { command: "ls", args: undefined },
    suggestions: [{ behavior: "allow" }],
    metadata: { requestedAt: new Date("2025-02-01T12:00:00.000Z") },
  };
  return { ...base, ...overrides };
}

describe("toStoredAgentRecord", () => {
  it("captures lifecycle metadata, config, and persistence", () => {
    const agent = createManagedAgent({
      currentModeId: "focus",
      persistence: {
        provider: "claude",
        sessionId: "persist-2",
        metadata: { resumedAt: new Date("2025-01-05T00:00:00.000Z"), note: "warm" },
      },
    });

    const record = toStoredAgentRecord(agent, { title: "Refactor Agent" });

    expect(record).toMatchObject({
      id: agent.id,
      provider: agent.provider,
      cwd: agent.cwd,
      title: "Refactor Agent",
      lastStatus: agent.lifecycle,
      lastModeId: "focus",
    });
    expect(record.createdAt).toBe(agent.createdAt.toISOString());
    expect(record.updatedAt).toBe(agent.updatedAt.toISOString());
    expect(record.lastActivityAt).toBe(agent.updatedAt.toISOString());
    expect(record.lastUserMessageAt).toBe(agent.lastUserMessageAt?.toISOString());
    expect(record.persistence).toEqual({
      provider: "claude",
      sessionId: "persist-2",
      metadata: {
        resumedAt: "2025-01-05T00:00:00.000Z",
        note: "warm",
      },
    });
    expect(record.runtimeInfo).toEqual({
      provider: "claude",
      sessionId: "session-123",
      model: "claude-3.5-sonnet",
      modeId: "plan",
    });
    expect(record.config).toEqual({
      modeId: agent.config.modeId,
      model: agent.config.model,
      providerOptions: { allowedTools: ["Read"] },
    });

    record.config!.providerOptions!.allowedTools = ["Bash"];
    expect(agent.config.providerOptions!.allowedTools).toEqual(["Read"]);
    record.persistence!.sessionId = "mutated";
    expect(agent.persistence!.sessionId).toBe("persist-2");
  });

  it("falls back to config mode when current mode is null and handles null title", () => {
    const agent = createManagedAgent({
      currentModeId: null,
      config: { modeId: "auto" },
      lastUserMessageAt: null,
    });

    const record = toStoredAgentRecord(agent);
    expect(record.title).toBeNull();
    expect(record.lastModeId).toBe("auto");
    expect(record.lastUserMessageAt).toBeNull();
  });

  it("omits config when no serializable fields exist", () => {
    const agent = createManagedAgent({
      config: {
        modeId: undefined,
        model: undefined,
        providerOptions: undefined,
        toolPolicy: undefined,
      },
    });

    const record = toStoredAgentRecord(agent);
    expect(record.config).toBeNull();
  });

  it("propagates lifecycle status for all states", () => {
    for (const status of AGENT_LIFECYCLE_STATUSES) {
      const agent = createManagedAgent({ lifecycle: status });
      const record = toStoredAgentRecord(agent);
      expect(record.lastStatus).toBe(status);
    }
  });
});

describe("toAgentPayload", () => {
  it("carries detached copy-safe options through closed snapshots and spreads without serializing them", () => {
    const agent = createManagedAgent({
      effectiveOptions: { test_feature: true, caller: { view: "runtime" } },
      controls: [{ type: "toggle", key: "test_feature", label: "Test feature" }],
    });
    const safeOptions = { test_feature: false, caller: { view: "required" } };
    attachAgentCopySafeOptions(agent, safeOptions);
    safeOptions.caller.view = "changed after capture";
    const closed: ManagedAgent = { ...agent, lifecycle: "closed", session: null };
    const payload = toAgentPayload(closed);
    const enriched = { ...payload, title: "Enriched title" };
    const message = mapAgentSnapshotEnvelopes(
      { type: "agent_update", payload: { kind: "upsert", agent: enriched } },
      (snapshot) => ({ ...snapshot, title: "Projected title" }),
    );

    expect(readAgentCopySafeOptions(message.payload.agent)).toEqual({
      options: { test_feature: false, caller: { view: "required" } },
    });
    const firstRead = readAgentCopySafeOptions(payload)!;
    (firstRead.options!.caller as { view: string }).view = "changed by one reader";
    expect(readAgentCopySafeOptions(payload)).toEqual({
      options: { test_feature: false, caller: { view: "required" } },
    });
    expect(readAgentCopySafeOptions(agent)).toEqual({
      options: { test_feature: false, caller: { view: "required" } },
    });
    expect(payload.options).toEqual({ test_feature: true, caller: { view: "runtime" } });
    expect(payload.features).toEqual([
      { type: "toggle", id: "test_feature", label: "Test feature", value: true },
    ]);
    const serialized = JSON.stringify(message);
    expect(serialized).not.toContain("required");
    expect(readAgentCopySafeOptions(JSON.parse(serialized).payload.agent)).toBeUndefined();
    expect(JSON.parse(serialized).payload.agent).toMatchObject({
      options: { test_feature: true, caller: { view: "runtime" } },
      features: [{ type: "toggle", id: "test_feature", label: "Test feature", value: true }],
    });
  });

  it("distinguishes captured absent options from a snapshot without copy-safe capture", () => {
    const agent = createManagedAgent({ effectiveOptions: { test_feature: true } });
    expect(readAgentCopySafeOptions(agent)).toBeUndefined();
    expect(readAgentCopySafeOptions(toAgentPayload(agent))).toBeUndefined();

    attachAgentCopySafeOptions(agent, undefined);
    const closed: ManagedAgent = { ...agent, lifecycle: "closed", session: null };
    const payload = toAgentPayload(closed);

    expect(readAgentCopySafeOptions({ ...payload })).toStrictEqual({ options: undefined });
    expect(payload.options).toEqual({ test_feature: true });
    expect(readAgentCopySafeOptions(JSON.parse(JSON.stringify(payload)))).toBeUndefined();
  });

  it("serializes dates, clones arrays, and hides session", () => {
    const permissionA = createPermission({ id: "perm-a" });
    const permissionB = createPermission({
      id: "perm-b",
      provider: "codex",
      metadata: { requestedAt: new Date("2025-02-02T00:00:00.000Z"), extra: { flag: true } },
    });
    const pending = new Map([
      [permissionA.id, permissionA],
      [permissionB.id, permissionB],
    ]);
    const agent = createManagedAgent({
      pendingPermissions: pending,
      lastUsage: { inputTokens: 10, outputTokens: 20 },
      lastError: "boom",
    });

    const payload = toAgentPayload(agent, { title: "UI Payload" });

    expect(payload.createdAt).toBe(agent.createdAt.toISOString());
    expect(payload.updatedAt).toBe(agent.updatedAt.toISOString());
    expect(payload.lastUserMessageAt).toBe(agent.lastUserMessageAt?.toISOString());
    expect(payload.title).toBe("UI Payload");
    expect(payload.model).toBe(agent.config.model);
    expect(payload.thinkingOptionId).toBeNull();
    expect(payload.pendingPermissions.map((item) => item.id)).toEqual(["perm-a", "perm-b"]);
    expect(payload.pendingPermissions[0]).not.toBe(permissionA);
    expect(payload.pendingPermissions[0].input).toEqual({ command: "ls" });
    expect(payload.pendingPermissions[1].metadata).toEqual({
      requestedAt: "2025-02-02T00:00:00.000Z",
      extra: { flag: true },
    });
    expect(payload.runtimeInfo).toEqual(agent.runtimeInfo);
    expect(payload.runtimeInfo).not.toBe(agent.runtimeInfo);
    expect(payload.availableModes).not.toBe(agent.availableModes);
    expect(payload.availableModes).toEqual(agent.availableModes);
    expect(payload.capabilities).not.toBe(agent.capabilities);
    expect(payload.capabilities).toEqual(agent.capabilities);
    expect(payload.lastUsage).toEqual(agent.lastUsage);
    expect(payload.lastUsage).not.toBe(agent.lastUsage);
    expect(payload.lastError).toBe("boom");
    expect((payload as unknown as { session?: unknown }).session).toBeUndefined();

    payload.availableModes[0].label = "Changed";
    expect(agent.availableModes[0].label).toBe("Planning");
    payload.capabilities.supportsStreaming = false;
    expect(agent.capabilities.supportsStreaming).toBe(true);
    payload.pendingPermissions[0].title = "Mutated title";
    expect(permissionA.title).toBe("Run command");
  });

  it("changes the usage scope key when the harness session or its model changes", () => {
    function usageScopeKey(usageSession: ReturnType<NonNullable<AgentSession["usageSession"]>>) {
      const session = { usageSession: () => usageSession } as unknown as AgentSession;
      return toAgentPayload(createManagedAgent({ session })).usageScopeKey;
    }
    const scope = { provider: "claude", model: "opus", env: {}, sessionKey: "session-a" };

    expect(usageScopeKey(scope)).toBe(usageScopeKey({ ...scope }));
    expect(usageScopeKey({ ...scope, sessionKey: "session-b" })).not.toBe(usageScopeKey(scope));
    expect(usageScopeKey({ ...scope, model: "sonnet" })).not.toBe(usageScopeKey(scope));
    expect(usageScopeKey(null)).toBeUndefined();
  });

  it("omits usage when any numeric usage field is NaN", () => {
    const fields = [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "totalCostUsd",
      "contextWindowMaxTokens",
      "contextWindowUsedTokens",
    ] as const;

    for (const field of fields) {
      const agent = createManagedAgent({
        lastUsage: {
          inputTokens: 10,
          cachedInputTokens: 5,
          outputTokens: 20,
          totalCostUsd: 0.5,
          contextWindowMaxTokens: 200_000,
          contextWindowUsedTokens: 100_000,
          [field]: Number.NaN,
        },
      });

      const payload = toAgentPayload(agent);
      expect(payload.lastUsage).toBeUndefined();
    }
  });

  it("produces null title and current mode even without overrides", () => {
    const agent = createManagedAgent({ currentModeId: null, lastUserMessageAt: null });
    const payload = toAgentPayload(agent);
    expect(payload.title).toBeNull();
    expect(payload.currentModeId).toBeNull();
    expect(payload.lastUserMessageAt).toBeNull();
    expect(payload.pendingPermissions).toEqual([]);
  });

  it("propagates lifecycle status for all states", () => {
    for (const status of AGENT_LIFECYCLE_STATUSES) {
      const agent = createManagedAgent({ lifecycle: status });
      const payload = toAgentPayload(agent);
      expect(payload.status).toBe(status);
    }
  });

  it("keeps persistence handles sanitized and detached", () => {
    const agent = createManagedAgent({
      persistence: {
        provider: "codex",
        sessionId: "persist-99",
        nativeHandle: { id: "native" } as unknown,
        metadata: {
          restored: new Date("2025-03-01T00:00:00.000Z"),
          paseoInstructionReceipt: { threadId: "persist-99", digest: "internal-digest" },
          toolPolicySource: "plugin",
          empty: {},
          mcpServers: {
            hub: {
              type: "http",
              headers: { Authorization: "Bearer projection-secret" },
            },
          },
        },
      },
    });
    const payload = toAgentPayload(agent);
    expect(payload.persistence).toEqual({
      provider: "codex",
      sessionId: "persist-99",
      nativeHandle: { id: "native" },
      metadata: { restored: "2025-03-01T00:00:00.000Z" },
    });
    (payload.persistence as AgentPersistenceHandle).sessionId = "mutated";
    expect(agent.persistence!.sessionId).toBe("persist-99");
  });

  it("removes empty persistence metadata after projecting MCP configuration", () => {
    const payload = toAgentPayload(
      createManagedAgent({
        provider: "codex",
        config: { provider: "codex" },
        persistence: {
          provider: "codex",
          sessionId: "persist-mcp-only",
          metadata: { mcpServers: { hub: { type: "http", url: "https://hub.test/mcp" } } },
        },
      }),
    );

    expect(payload.persistence).toEqual({
      provider: "codex",
      sessionId: "persist-mcp-only",
    });
  });

  it("strips MCP metadata from stored wire payloads while preserving private persistence", () => {
    const record = toStoredAgentRecord(
      createManagedAgent({
        provider: "codex",
        config: { provider: "codex" },
        persistence: {
          provider: "codex",
          sessionId: "persist-stored",
          metadata: {
            conversationId: "conversation-stored",
            pluginAppendSystemPrompt: ["plugin instruction"],
            daemonAppendSystemPrompt: "daemon instruction",
            mcpServers: {
              hub: {
                type: "http",
                headers: { Authorization: "Bearer stored-projection-secret" },
              },
            },
          },
        },
      }),
    );

    const payload = buildStoredAgentPayload(record, ["codex"], ownOptionsOnly);

    expect(record.persistence?.metadata).toEqual({
      conversationId: "conversation-stored",
      pluginAppendSystemPrompt: ["plugin instruction"],
      daemonAppendSystemPrompt: "daemon instruction",
      mcpServers: {
        hub: {
          type: "http",
          headers: { Authorization: "Bearer stored-projection-secret" },
        },
      },
    });
    expect(payload.persistence?.metadata).toEqual({
      conversationId: "conversation-stored",
    });
  });

  it.each([
    { name: "live", project: (agent: ManagedAgent) => toAgentPayload(agent) },
    {
      name: "stored",
      project: (agent: ManagedAgent) =>
        buildStoredAgentPayload(toStoredAgentRecord(agent), ["codex"], ownOptionsOnly),
    },
  ])("scrubs generic launch configuration from $name persistence handles only", ({ project }) => {
    const agent = createManagedAgent({
      provider: "codex",
      config: { provider: "codex" },
      persistence: {
        provider: "codex",
        sessionId: "persist-generic",
        nativeHandle: { opaqueProviderState: { systemPrompt: "provider-owned history" } },
        metadata: {
          conversationId: "keep-conversation",
          pluginConfigAdoptions: { version: 1, receipts: [{ id: "private-receipt" }] },
          launchId: "private-launch",
          systemPrompt: "dummy-prompt-secret",
          providerOptions: { token: "dummy-option-secret" },
          env: { TOKEN: "dummy-env-secret" },
          launchEnv: { TOKEN: "dummy-launch-env-secret" },
          pluginToolPolicy: { preapproved: [{ kind: "mcp", server: "notes", tool: "read" }] },
          nestedProviderData: { systemPrompt: "opaque-provider-metadata" },
        },
      },
    });

    const payload = project(agent);

    expect(payload.persistence).toEqual({
      provider: "codex",
      sessionId: "persist-generic",
      nativeHandle: { opaqueProviderState: { systemPrompt: "provider-owned history" } },
      metadata: {
        conversationId: "keep-conversation",
        nestedProviderData: { systemPrompt: "opaque-provider-metadata" },
      },
    });
    expect(agent.persistence?.metadata).toEqual({
      conversationId: "keep-conversation",
      pluginConfigAdoptions: { version: 1, receipts: [{ id: "private-receipt" }] },
      launchId: "private-launch",
      systemPrompt: "dummy-prompt-secret",
      providerOptions: { token: "dummy-option-secret" },
      env: { TOKEN: "dummy-env-secret" },
      launchEnv: { TOKEN: "dummy-launch-env-secret" },
      pluginToolPolicy: { preapproved: [{ kind: "mcp", server: "notes", tool: "read" }] },
      nestedProviderData: { systemPrompt: "opaque-provider-metadata" },
    });
  });

  it.each([
    {
      name: "absent baseline with provider defaults",
      baseline: { id: "inherit", label: "Inherit", kind: "absent" as const },
      providerDefaults: { fast_mode: false },
      expectedOptions: { fast_mode: false, caller: { keep: "original" } },
      expectedReceipt: {
        id: "receipt-fast",
        pluginId: "notes",
        recipeDigest: "recipe-notes",
        selectorId: "fast",
        fragmentDigest: "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b",
        fragment: {
          kind: "option",
          key: "fast_mode",
          baseline: { id: "inherit", label: "Inherit", kind: "absent" },
        },
      },
    },
    {
      name: "explicit false baseline over provider defaults",
      baseline: { id: "off", label: "Off", kind: "value" as const, value: false },
      providerDefaults: { fast_mode: true },
      expectedOptions: { fast_mode: false, caller: { keep: "original" } },
      expectedReceipt: {
        id: "receipt-fast",
        pluginId: "notes",
        recipeDigest: "recipe-notes",
        selectorId: "fast",
        fragmentDigest: "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b",
        fragment: {
          kind: "option",
          key: "fast_mode",
          baseline: { id: "off", label: "Off", kind: "value", value: false },
        },
      },
    },
  ])(
    "projects stored adoption options using $name without changing saved intent",
    ({ baseline, providerDefaults, expectedOptions, expectedReceipt }) => {
      const record = toStoredAgentRecord(
        createManagedAgent({
          lifecycle: "closed",
          controls: [{ type: "toggle", key: "fast_mode", label: "Fast" }],
          config: {
            modeId: undefined,
            model: undefined,
            providerOptions: { fast_mode: true, caller: { keep: "original" } },
            systemPrompt: "Caller instructions",
          },
          launchEnv: { CALLER: "saved-env" },
        }),
      );
      const receipts: PluginConfigAdoptions = {
        version: 1,
        receipts: [
          {
            id: "receipt-fast",
            pluginId: "notes",
            recipeDigest: "recipe-notes",
            selectorId: "fast",
            fragmentDigest: "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b",
            fragment: { kind: "option", key: "fast_mode", baseline },
          },
        ],
      };
      record.pluginConfigAdoptions = receipts;

      const payload = buildStoredAgentPayload(record, ["claude"], (_provider, own) => ({
        ...providerDefaults,
        ...own,
      }));

      expect(payload.options).toEqual(expectedOptions);
      expect(payload.features).toEqual([
        { type: "toggle", id: "fast_mode", label: "Fast", value: false },
      ]);
      expect(payload).not.toHaveProperty("pluginConfigAdoptions");
      expect(record.pluginConfigAdoptions).toBe(receipts);
      expect(receipts).toEqual({ version: 1, receipts: [expectedReceipt] });
      expect(record.config).toEqual({
        providerOptions: { fast_mode: true, caller: { keep: "original" } },
        systemPrompt: "Caller instructions",
      });
      expect(record.launchEnv).toEqual({ CALLER: "saved-env" });
      const projectedCaller = payload.options?.caller as { keep: string };
      projectedCaller.keep = "changed in wire payload";
      expect(record.config?.providerOptions).toEqual({
        fast_mode: true,
        caller: { keep: "original" },
      });
    },
  );

  it.each([
    {
      name: "saved option changes",
      fragment: {
        kind: "option" as const,
        key: "fast_mode",
        baseline: { id: "off", label: "Off", kind: "value" as const, value: false },
      },
      fragmentDigest: "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b",
    },
    {
      name: "saved launch environment changes",
      fragment: {
        kind: "env" as const,
        key: "CALLER",
        baseline: { id: "inherit", label: "Inherit", kind: "absent" as const },
      },
      fragmentDigest: "a99c33bbe8bcb5463fcc1b1ec661e91f663c1b48278bc56a16e0566283559700",
    },
  ])(
    "rejects stored snapshot projection when $name after adoption",
    ({ fragment, fragmentDigest }) => {
      const record = toStoredAgentRecord(
        createManagedAgent({
          lifecycle: "closed",
          config: { providerOptions: { fast_mode: false } },
          launchEnv: { CALLER: "changed-env" },
        }),
      );
      record.pluginConfigAdoptions = {
        version: 1,
        receipts: [
          {
            id: "receipt-stale",
            pluginId: "notes",
            recipeDigest: "recipe-notes",
            selectorId: "stale",
            fragmentDigest,
            fragment,
          },
        ],
      };

      expect(() => buildStoredAgentPayload(record, ["claude"], ownOptionsOnly)).toThrow(
        "Adopted plugin configuration is stale; reset the affected selection before editing it",
      );
      expect(record.config?.providerOptions).toEqual({ fast_mode: false });
      expect(record.launchEnv).toEqual({ CALLER: "changed-env" });
    },
  );

  it("projects a closed agent's stored controls and options", () => {
    const controls: AgentOptionControl[] = [
      {
        type: "select",
        key: "service_tier",
        label: "Speed",
        defaultValue: "default",
        choices: [
          { value: "default", label: "Normal" },
          { value: "priority", label: "Fast" },
        ],
      },
    ];
    const record = toStoredAgentRecord(
      createManagedAgent({
        provider: "codex",
        lifecycle: "closed",
        controls,
        config: {
          provider: "codex",
          providerOptions: { service_tier: "priority", sandbox_mode: "read-only" },
        },
      }),
    );

    const payload = buildStoredAgentPayload(record, ["codex"], ownOptionsOnly);

    expect(payload.status).toBe("closed");
    expect(payload.controls).toEqual(controls);
    expect(payload.options).toEqual({ service_tier: "priority", sandbox_mode: "read-only" });
    expect(payload.features).toEqual([
      {
        type: "select",
        id: "service_tier",
        label: "Speed",
        value: "priority",
        options: [
          { id: "default", label: "Normal", isDefault: true },
          { id: "priority", label: "Fast" },
        ],
      },
    ]);
  });

  it("projects a closed agent's options with the provider defaults under its own, like a live one", () => {
    const record = toStoredAgentRecord(
      createManagedAgent({
        provider: "claude",
        lifecycle: "closed",
        controls: [{ type: "toggle", key: "fast_mode", label: "Fast" }],
        config: { provider: "claude", providerOptions: {} },
      }),
    );
    const withConfigDefaults = (_provider: string, own: Record<string, unknown> | undefined) => ({
      fast_mode: true,
      ...own,
    });

    const payload = buildStoredAgentPayload(record, ["claude"], withConfigDefaults);

    expect(payload.options).toEqual({ fast_mode: true });
    expect(payload.features).toEqual([
      { type: "toggle", id: "fast_mode", label: "Fast", value: true },
    ]);
  });

  it("carries a stored lastError onto the payload", () => {
    const record = toStoredAgentRecord(
      createManagedAgent({ provider: "codex", config: { provider: "codex" }, lastError: "boom" }),
    );

    expect(buildStoredAgentPayload(record, ["codex"], ownOptionsOnly).lastError).toBe("boom");
    expect(
      buildStoredAgentPayload({ ...record, lastError: null }, ["codex"], ownOptionsOnly),
    ).not.toHaveProperty("lastError");
  });

  it("omits lastUsage when not available", () => {
    const agent = createManagedAgent({ lastUsage: undefined });
    const payload = toAgentPayload(agent);
    expect(payload).not.toHaveProperty("lastUsage");
  });

  it("preserves context window usage fields when they are valid numbers", () => {
    const agent = createManagedAgent({
      lastUsage: {
        inputTokens: 10,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 42_000,
      },
    });

    const payload = toAgentPayload(agent);

    expect(payload.lastUsage).toEqual({
      inputTokens: 10,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 42_000,
    });
  });

  it("omits lastUsage when context window usage fields are invalid", () => {
    const agent = createManagedAgent({
      lastUsage: {
        inputTokens: 10,
        contextWindowMaxTokens: "200000" as unknown as number,
        contextWindowUsedTokens: NaN,
      },
    });

    const payload = toAgentPayload(agent);

    expect(payload).not.toHaveProperty("lastUsage");
  });

  it("keeps existing lastUsage behavior when context window fields are absent", () => {
    const agent = createManagedAgent({
      lastUsage: {
        inputTokens: 10,
        outputTokens: 20,
        totalCostUsd: 1.25,
      },
    });

    const payload = toAgentPayload(agent);

    expect(payload.lastUsage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalCostUsd: 1.25,
    });
  });

  it("projects controls, effective options, and legacy features from the same source", () => {
    const controls: AgentOptionControl[] = [
      { type: "toggle", key: "fast_mode", label: "Fast mode" },
      {
        type: "select",
        key: "service_tier",
        label: "Speed",
        defaultValue: "default",
        choices: [
          { value: "default", label: "Normal" },
          { value: "fast", label: "Fast" },
        ],
      },
    ];
    // `config.json` supplies fast_mode; the agent itself sets nothing for service_tier.
    // Options without a control are part of the snapshot too.
    const agent = createManagedAgent({
      controls,
      effectiveOptions: { fast_mode: true, sandbox_mode: "workspace-write" },
    });

    const payload = toAgentPayload(agent);

    expect(payload.controls).toEqual(controls);
    expect(payload.options).toEqual({ fast_mode: true, sandbox_mode: "workspace-write" });
    expect(payload.features).toEqual([
      { type: "toggle", id: "fast_mode", label: "Fast mode", value: true },
      {
        type: "select",
        id: "service_tier",
        label: "Speed",
        value: "default",
        options: [
          { id: "default", label: "Normal", isDefault: true },
          { id: "fast", label: "Fast" },
        ],
      },
    ]);
  });
});

describe("toRecentProviderSessionDescriptorPayload", () => {
  it("projects provider import rows to provider-opaque public recent sessions", () => {
    const session: ImportableProviderSession & { provider: string } = {
      provider: "codex-custom",
      providerHandleId: "provider-native-handle",
      cwd: "/tmp/project",
      title: "Import me",
      firstPromptPreview: "First prompt with spacing",
      lastPromptPreview: "Second prompt",
      lastActivityAt: new Date("2026-04-30T12:34:56.000Z"),
    };

    const payload = toRecentProviderSessionDescriptorPayload(session, {
      providerLabel: "Custom Codex",
    });

    expect(payload).toEqual({
      providerId: "codex-custom",
      providerLabel: "Custom Codex",
      providerHandleId: "provider-native-handle",
      cwd: "/tmp/project",
      title: "Import me",
      firstPromptPreview: "First prompt with spacing",
      lastPromptPreview: "Second prompt",
      lastActivityAt: "2026-04-30T12:34:56.000Z",
    });
    expect(payload).not.toHaveProperty("providerKind");
    expect(payload).not.toHaveProperty("sessionId");
    expect(payload).not.toHaveProperty("nativeHandle");
  });

  it("preserves null prompt previews", () => {
    const session: ImportableProviderSession & { provider: string } = {
      provider: "claude-custom",
      providerHandleId: "provider-session-id",
      cwd: "/tmp/project",
      title: null,
      lastActivityAt: new Date("2026-04-30T12:34:56.000Z"),
      firstPromptPreview: null,
      lastPromptPreview: null,
    };

    expect(
      toRecentProviderSessionDescriptorPayload(session, {
        providerLabel: "Custom Claude",
      }),
    ).toMatchObject({
      providerId: "claude-custom",
      providerLabel: "Custom Claude",
      providerHandleId: "provider-session-id",
      firstPromptPreview: null,
      lastPromptPreview: null,
    });
  });
});

it("omits unknown background work and preserves known summary in list items", () => {
  const snapshot = toAgentPayload(createManagedAgent());
  expect(toAgentListItemPayload(snapshot)).not.toHaveProperty("backgroundWork");
  expect(toAgentListItemPayload({ ...snapshot, backgroundWork: { count: 2 } })).toMatchObject({
    backgroundWork: { count: 2 },
  });
});
