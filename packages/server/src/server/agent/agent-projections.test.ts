import { describe, expect, it } from "vitest";

import {
  AGENT_LIFECYCLE_STATUSES,
  type AgentLifecycleStatus,
} from "./agent-manager.js";
import { toAgentPayload, toStoredAgentRecord, type ManagedAgent } from "./agent-projections.js";
import type {
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentSessionConfig,
} from "./agent-sdk-types.js";

type ManagedAgentOverrides = Omit<
  Partial<ManagedAgent>,
  "config" | "pendingPermissions"
> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
};

function createManagedAgent(
  overrides: ManagedAgentOverrides = {}
): ManagedAgent {
  const now = new Date("2025-01-01T00:00:00.000Z");
  const baseConfig: AgentSessionConfig = {
    provider: "claude",
    cwd: "/tmp/project",
    modeId: "plan",
    model: "claude-3.5-sonnet",
    extra: {
      claude: { tone: "friendly" },
    },
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
    lifecycle === "closed" ? null : restOverrides.session ?? ({} as any);
  const pendingRunValue =
    restOverrides.pendingRun ??
    (lifecycle === "running" ? (async function* noop() {})() : null);
  const lastErrorValue =
    restOverrides.lastError ??
    (lifecycle === "error" ? "encountered error" : undefined);

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
    pendingPermissions:
      pendingPermissionsOverride ?? new Map<string, AgentPermissionRequest>(),
    pendingRun: pendingRunValue as ManagedAgent["pendingRun"],
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

function createPermission(
  overrides: Partial<AgentPermissionRequest> = {}
): AgentPermissionRequest {
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
      extra: { claude: { tone: "friendly" } },
    });

    record.config!.extra!.claude!.tone = "serious";
    expect(agent.config.extra!.claude!.tone).toBe("friendly");
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
        extra: undefined,
      },
    });

    const record = toStoredAgentRecord(agent);
    expect(record.config).toBeNull();
  });

  it("propagates lifecycle status for all states", () => {
    for (const status of AGENT_LIFECYCLE_STATUSES) {
      const agent = createManagedAgent({ lifecycle: status as AgentLifecycleStatus });
      const record = toStoredAgentRecord(agent);
      expect(record.lastStatus).toBe(status);
    }
  });
});

describe("toAgentPayload", () => {
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
    expect(payload.pendingPermissions.map((item) => item.id)).toEqual([
      "perm-a",
      "perm-b",
    ]);
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
    expect((payload as any).session).toBeUndefined();

    payload.availableModes[0].label = "Changed";
    expect(agent.availableModes[0].label).toBe("Planning");
    payload.capabilities.supportsStreaming = false;
    expect(agent.capabilities.supportsStreaming).toBe(true);
    payload.pendingPermissions[0].title = "Mutated title";
    expect(permissionA.title).toBe("Run command");
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
      const agent = createManagedAgent({ lifecycle: status as AgentLifecycleStatus });
      const payload = toAgentPayload(agent);
      expect(payload.status).toBe(status);
    }
  });

  it("keeps persistence handles sanitized and detached", () => {
    const agent = createManagedAgent({
      persistence: {
        provider: "codex",
        sessionId: "persist-99",
        nativeHandle: { id: "native" } as any,
        metadata: { restored: new Date("2025-03-01T00:00:00.000Z"), empty: {} },
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

  it("omits lastUsage when not available", () => {
    const agent = createManagedAgent({ lastUsage: undefined });
    const payload = toAgentPayload(agent);
    expect(payload).not.toHaveProperty("lastUsage");
  });
});
