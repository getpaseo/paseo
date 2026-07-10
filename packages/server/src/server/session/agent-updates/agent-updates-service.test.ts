import { describe, expect, test } from "vitest";
import type pino from "pino";
import { createAgentUpdatesService, matchesAgentUpdatesFilter } from "./agent-updates-service.js";
import type {
  AgentSnapshotPayload,
  ProjectPlacementPayload,
  SessionOutboundMessage,
} from "../../messages.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { StoredAgentRecord } from "../../agent/agent-storage.js";

// No mocks — every dependency is an injected in-memory fake. The agent payloads
// are supplied through the fake builders, so each test fully controls the
// (agent, project, filter) triple the service reasons about and asserts the
// emitted `agent_update` payloads.

type AgentUpdatePayload = Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"];

function makeAgentPayload(input: {
  id: string;
  workspaceId?: string;
  provider?: string;
  status?: AgentSnapshotPayload["status"];
  updatedAt?: string;
  archivedAt?: string | null;
  labels?: Record<string, string>;
  requiresAttention?: boolean;
  effectiveThinkingOptionId?: string | null;
  thinkingOptionId?: string | null;
}): AgentSnapshotPayload {
  const updatedAt = input.updatedAt ?? "2026-03-01T12:00:00.000Z";
  const provider = input.provider ?? "codex";
  return {
    id: input.id,
    provider,
    cwd: "/tmp/repo",
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    model: null,
    thinkingOptionId: input.thinkingOptionId ?? null,
    effectiveThinkingOptionId: input.effectiveThinkingOptionId ?? null,
    createdAt: updatedAt,
    updatedAt,
    lastUserMessageAt: null,
    status: input.status ?? "running",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: { provider, sessionId: null },
    title: null,
    labels: input.labels ?? {},
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: input.archivedAt ?? null,
  };
}

function makeProject(overrides?: Partial<ProjectPlacementPayload>): ProjectPlacementPayload {
  return {
    projectKey: "proj-1",
    projectName: "repo",
    workspaceName: "main",
    checkout: {
      cwd: "/tmp/repo",
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    },
    ...overrides,
  };
}

function buildHarness() {
  const emitted: SessionOutboundMessage[] = [];
  const workspaceUpdates: string[] = [];
  const loggedErrors: unknown[][] = [];
  const payloadById = new Map<string, AgentSnapshotPayload>();
  const projectByWorkspaceId = new Map<string, ProjectPlacementPayload | null>();
  let providerVisible: (provider: string) => boolean = () => true;
  let buildAgentPayloadError: Error | null = null;

  const service = createAgentUpdatesService({
    emit: (message) => emitted.push(message),
    buildAgentPayload: async (agent) => {
      if (buildAgentPayloadError) {
        throw buildAgentPayloadError;
      }
      const payload = payloadById.get(agent.id);
      if (!payload) {
        throw new Error(`no payload registered for ${agent.id}`);
      }
      return payload;
    },
    buildStoredAgentPayload: (record) => {
      const payload = payloadById.get(record.id);
      if (!payload) {
        throw new Error(`no payload registered for ${record.id}`);
      }
      return payload;
    },
    isProviderVisibleToClient: (provider) => providerVisible(provider),
    buildProjectPlacementForWorkspaceId: async (workspaceId) =>
      projectByWorkspaceId.get(workspaceId) ?? null,
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      workspaceUpdates.push(workspaceId);
    },
    logger: { error: (...args: unknown[]) => loggedErrors.push(args) } as unknown as pino.Logger,
  });

  return {
    service,
    emitted,
    workspaceUpdates,
    loggedErrors,
    // Register the payload a builder returns for an agent id, plus the project
    // its workspaceId resolves to (null = no placement).
    register(
      payload: AgentSnapshotPayload,
      project: ProjectPlacementPayload | null = makeProject(),
    ) {
      payloadById.set(payload.id, payload);
      if (payload.workspaceId) {
        projectByWorkspaceId.set(payload.workspaceId, project);
      }
      return payload;
    },
    setProviderVisible(fn: (provider: string) => boolean) {
      providerVisible = fn;
    },
    failBuildAgentPayload(error: Error) {
      buildAgentPayloadError = error;
    },
    agentUpdates(): AgentUpdatePayload[] {
      return emitted
        .filter((message) => message.type === "agent_update")
        .map(
          (message) =>
            (message as Extract<SessionOutboundMessage, { type: "agent_update" }>).payload,
        );
    },
    managed(id: string): ManagedAgent {
      return { id } as unknown as ManagedAgent;
    },
    stored(id: string): StoredAgentRecord {
      return { id } as unknown as StoredAgentRecord;
    },
  };
}

describe("matchesAgentUpdatesFilter", () => {
  const project = makeProject();

  test("no filter matches", () => {
    expect(matchesAgentUpdatesFilter({ agent: makeAgentPayload({ id: "a" }), project })).toBe(true);
  });

  test("label match vs mismatch", () => {
    const agent = makeAgentPayload({ id: "a", labels: { surface: "voice" } });
    expect(
      matchesAgentUpdatesFilter({ agent, project, filter: { labels: { surface: "voice" } } }),
    ).toBe(true);
    expect(
      matchesAgentUpdatesFilter({ agent, project, filter: { labels: { surface: "cli" } } }),
    ).toBe(false);
  });

  test("archived agents are excluded unless includeArchived", () => {
    const agent = makeAgentPayload({ id: "a", archivedAt: "2026-03-02T00:00:00.000Z" });
    expect(matchesAgentUpdatesFilter({ agent, project, filter: {} })).toBe(false);
    expect(matchesAgentUpdatesFilter({ agent, project, filter: { includeArchived: true } })).toBe(
      true,
    );
  });

  test("thinking-option filter compares the resolved option", () => {
    const high = makeAgentPayload({ id: "a", effectiveThinkingOptionId: "high" });
    expect(
      matchesAgentUpdatesFilter({ agent: high, project, filter: { thinkingOptionId: "high" } }),
    ).toBe(true);
    expect(
      matchesAgentUpdatesFilter({ agent: high, project, filter: { thinkingOptionId: "low" } }),
    ).toBe(false);
    // undefined means "don't filter on thinking option".
    expect(matchesAgentUpdatesFilter({ agent: high, project, filter: {} })).toBe(true);
  });

  test("status filter", () => {
    const agent = makeAgentPayload({ id: "a", status: "running" });
    expect(matchesAgentUpdatesFilter({ agent, project, filter: { statuses: ["running"] } })).toBe(
      true,
    );
    expect(matchesAgentUpdatesFilter({ agent, project, filter: { statuses: ["closed"] } })).toBe(
      false,
    );
  });

  test("requiresAttention filter", () => {
    const agent = makeAgentPayload({ id: "a", requiresAttention: true });
    expect(matchesAgentUpdatesFilter({ agent, project, filter: { requiresAttention: true } })).toBe(
      true,
    );
    expect(
      matchesAgentUpdatesFilter({ agent, project, filter: { requiresAttention: false } }),
    ).toBe(false);
  });

  test("projectKeys filter, ignoring blank entries", () => {
    const agent = makeAgentPayload({ id: "a" });
    const inProject = makeProject({ projectKey: "proj-1" });
    const otherProject = makeProject({ projectKey: "proj-2" });
    expect(
      matchesAgentUpdatesFilter({ agent, project: inProject, filter: { projectKeys: ["proj-1"] } }),
    ).toBe(true);
    expect(
      matchesAgentUpdatesFilter({
        agent,
        project: otherProject,
        filter: { projectKeys: ["proj-1"] },
      }),
    ).toBe(false);
    // A whitespace-only key is trimmed away, leaving no constraint.
    expect(
      matchesAgentUpdatesFilter({ agent, project: otherProject, filter: { projectKeys: ["  "] } }),
    ).toBe(true);
  });
});

describe("forwardLiveAgent", () => {
  test("emits an upsert for a matching agent and updates its workspace", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });
    h.service.flushBootstrapped("sub");
    h.register(makeAgentPayload({ id: "a", workspaceId: "ws-1" }));

    await h.service.forwardLiveAgent(h.managed("a"));

    expect(h.agentUpdates()).toEqual([
      { kind: "upsert", agent: expect.objectContaining({ id: "a" }), project: makeProject() },
    ]);
    expect(h.workspaceUpdates).toEqual(["ws-1"]);
  });

  test("emits a remove when the agent's workspace resolves to no project", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });
    h.service.flushBootstrapped("sub");
    h.register(makeAgentPayload({ id: "a", workspaceId: "ws-1" }), null);

    await h.service.forwardLiveAgent(h.managed("a"));

    expect(h.agentUpdates()).toEqual([{ kind: "remove", agentId: "a" }]);
  });

  test("emits a remove when the agent does not match the filter", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: { statuses: ["closed"] } });
    h.service.flushBootstrapped("sub");
    h.register(makeAgentPayload({ id: "a", workspaceId: "ws-1", status: "running" }));

    await h.service.forwardLiveAgent(h.managed("a"));

    expect(h.agentUpdates()).toEqual([{ kind: "remove", agentId: "a" }]);
  });

  test("with no subscription, emits no agent_update but still updates the workspace", async () => {
    const h = buildHarness();
    h.register(makeAgentPayload({ id: "a", workspaceId: "ws-1" }));

    await h.service.forwardLiveAgent(h.managed("a"));

    expect(h.agentUpdates()).toEqual([]);
    expect(h.workspaceUpdates).toEqual(["ws-1"]);
  });

  test("drops an upsert whose provider is not visible to the client", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });
    h.service.flushBootstrapped("sub");
    h.setProviderVisible(() => false);
    h.register(makeAgentPayload({ id: "a", workspaceId: "ws-1", provider: "pi" }));

    await h.service.forwardLiveAgent(h.managed("a"));

    expect(h.agentUpdates()).toEqual([]);
    // The workspace-update tail still fires regardless of visibility.
    expect(h.workspaceUpdates).toEqual(["ws-1"]);
  });

  test("swallows and logs a build error without throwing", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });
    h.service.flushBootstrapped("sub");
    h.failBuildAgentPayload(new Error("boom"));

    await expect(h.service.forwardLiveAgent(h.managed("a"))).resolves.toBeUndefined();
    expect(h.loggedErrors).toHaveLength(1);
    expect(h.agentUpdates()).toEqual([]);
  });
});

describe("emitStoredRecord", () => {
  test("returns the built payload and emits an upsert when matching", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });
    h.service.flushBootstrapped("sub");
    h.register(makeAgentPayload({ id: "a", workspaceId: "ws-1" }));

    const payload = await h.service.emitStoredRecord(h.stored("a"));

    expect(payload.id).toBe("a");
    expect(h.agentUpdates()).toEqual([
      { kind: "upsert", agent: expect.objectContaining({ id: "a" }), project: makeProject() },
    ]);
  });

  test("emits a remove when no project resolves", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });
    h.service.flushBootstrapped("sub");
    h.register(makeAgentPayload({ id: "a", workspaceId: "ws-1" }), null);

    await h.service.emitStoredRecord(h.stored("a"));

    expect(h.agentUpdates()).toEqual([{ kind: "remove", agentId: "a" }]);
  });

  test("emits a remove when the record no longer matches the filter", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: { includeArchived: false } });
    h.service.flushBootstrapped("sub");
    h.register(
      makeAgentPayload({ id: "a", workspaceId: "ws-1", archivedAt: "2026-03-02T00:00:00.000Z" }),
    );

    await h.service.emitStoredRecord(h.stored("a"));

    expect(h.agentUpdates()).toEqual([{ kind: "remove", agentId: "a" }]);
  });

  test("returns the payload but emits nothing when there is no subscription", async () => {
    const h = buildHarness();
    h.register(makeAgentPayload({ id: "a", workspaceId: "ws-1" }));

    const payload = await h.service.emitStoredRecord(h.stored("a"));

    expect(payload.id).toBe("a");
    expect(h.agentUpdates()).toEqual([]);
  });
});

describe("bootstrap buffering", () => {
  test("buffers updates while bootstrapping and replays them on flush", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });
    h.register(makeAgentPayload({ id: "a", workspaceId: "ws-1" }));

    await h.service.forwardLiveAgent(h.managed("a"));
    expect(h.agentUpdates()).toEqual([]); // buffered, not emitted yet

    h.service.flushBootstrapped("sub");
    expect(h.agentUpdates()).toEqual([
      { kind: "upsert", agent: expect.objectContaining({ id: "a" }), project: makeProject() },
    ]);
  });

  test("keeps only the latest buffered update per agent", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });

    h.register(makeAgentPayload({ id: "a", workspaceId: "ws-1", status: "running" }));
    await h.service.forwardLiveAgent(h.managed("a"));
    h.register(makeAgentPayload({ id: "a", workspaceId: "ws-1", status: "closed" }));
    await h.service.forwardLiveAgent(h.managed("a"));

    h.service.flushBootstrapped("sub");

    const updates = h.agentUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      kind: "upsert",
      agent: { id: "a", status: "closed" },
    });
  });

  test("skips a buffered upsert that is not newer than the snapshot", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });

    h.register(
      makeAgentPayload({ id: "stale", workspaceId: "ws-1", updatedAt: "2026-03-01T00:00:00.000Z" }),
    );
    await h.service.forwardLiveAgent(h.managed("stale"));
    h.register(
      makeAgentPayload({ id: "fresh", workspaceId: "ws-1", updatedAt: "2026-03-05T00:00:00.000Z" }),
    );
    await h.service.forwardLiveAgent(h.managed("fresh"));

    h.service.flushBootstrapped("sub", {
      snapshotUpdatedAtByAgentId: new Map([
        ["stale", Date.parse("2026-03-02T00:00:00.000Z")], // snapshot newer → drop
        ["fresh", Date.parse("2026-03-02T00:00:00.000Z")], // update newer → keep
      ]),
    });

    expect(h.agentUpdates()).toEqual([
      { kind: "upsert", agent: expect.objectContaining({ id: "fresh" }), project: makeProject() },
    ]);
  });

  test("a removed agent is always replayed, even against a snapshot", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });

    h.service.removeAgent("a");
    expect(h.agentUpdates()).toEqual([]); // buffered

    h.service.flushBootstrapped("sub", {
      snapshotUpdatedAtByAgentId: new Map([["a", Date.parse("2030-01-01T00:00:00.000Z")]]),
    });
    expect(h.agentUpdates()).toEqual([{ kind: "remove", agentId: "a" }]);
  });

  test("does not buffer an upsert for a provider that is not visible", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });
    h.setProviderVisible(() => false);
    h.register(makeAgentPayload({ id: "a", workspaceId: "ws-1", provider: "pi" }));

    await h.service.forwardLiveAgent(h.managed("a"));
    h.service.flushBootstrapped("sub");

    expect(h.agentUpdates()).toEqual([]);
  });
});

describe("subscription lifecycle", () => {
  test("flushBootstrapped is a no-op for a stale subscription id", async () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });
    h.register(makeAgentPayload({ id: "a", workspaceId: "ws-1" }));
    await h.service.forwardLiveAgent(h.managed("a"));

    h.service.flushBootstrapped("other-sub");
    expect(h.agentUpdates()).toEqual([]); // still buffering

    h.service.flushBootstrapped("sub");
    expect(h.agentUpdates()).toHaveLength(1);
  });

  test("clearSubscription only clears the current subscription", () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });

    h.service.clearSubscription("other-sub");
    expect(h.service.hasSubscription()).toBe(true);

    h.service.clearSubscription("sub");
    expect(h.service.hasSubscription()).toBe(false);
  });

  test("dispose drops the subscription", () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });
    expect(h.service.hasSubscription()).toBe(true);

    h.service.dispose();
    expect(h.service.hasSubscription()).toBe(false);
  });

  test("removeAgent is a no-op without a subscription", () => {
    const h = buildHarness();
    h.service.removeAgent("a");
    expect(h.agentUpdates()).toEqual([]);
  });

  test("removeAgent emits a remove for a live subscription", () => {
    const h = buildHarness();
    h.service.beginSubscription({ subscriptionId: "sub", filter: {} });
    h.service.flushBootstrapped("sub");

    h.service.removeAgent("a");

    expect(h.agentUpdates()).toEqual([{ kind: "remove", agentId: "a" }]);
  });
});
