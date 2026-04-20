import { describe, expect, test, vi } from "vitest";
import type { ManagedAgent } from "./agent/agent-manager.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import {
  attachAgentStoragePersistence,
  buildConfigOverrides,
  buildSessionConfig,
} from "./persistence-hooks.js";
import type {
  AgentPermissionRequest,
  AgentSession,
  AgentSessionConfig,
} from "./agent/agent-sdk-types.js";

const testLogger = {
  child: () => testLogger,
  error: vi.fn(),
  warn: vi.fn(),
} as any;

type ManagedAgentOverrides = Omit<
  Partial<ManagedAgent>,
  "config" | "pendingPermissions" | "session" | "activeForegroundTurnId"
> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
  session?: AgentSession | null;
  activeForegroundTurnId?: string | null;
};

function createManagedAgent(overrides: ManagedAgentOverrides = {}): ManagedAgent {
  const now = overrides.updatedAt ?? new Date("2025-01-01T00:00:00.000Z");
  const provider = overrides.provider ?? "claude";
  const cwd = overrides.cwd ?? "/tmp/project";
  const lifecycle = overrides.lifecycle ?? "idle";
  const configOverrides = overrides.config ?? {};
  const config: AgentSessionConfig = {
    provider,
    cwd,
    modeId: configOverrides.modeId ?? "plan",
    model: configOverrides.model ?? "claude-3.5-sonnet",
    extra: configOverrides.extra ?? { claude: { tone: "focused" } },
  };
  const session = lifecycle === "closed" ? null : (overrides.session ?? ({} as AgentSession));
  const activeForegroundTurnId =
    overrides.activeForegroundTurnId ?? (lifecycle === "running" ? "test-turn-id" : null);

  const agent: ManagedAgent = {
    id: overrides.id ?? "agent-1",
    provider,
    cwd,
    session,
    capabilities: overrides.capabilities ?? {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    config,
    lifecycle,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    availableModes: overrides.availableModes ?? [],
    currentModeId: overrides.currentModeId ?? config.modeId ?? null,
    pendingPermissions: overrides.pendingPermissions ?? new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: overrides.timeline ?? [],
    persistence: overrides.persistence ?? null,
    historyPrimed: overrides.historyPrimed ?? true,
    lastUserMessageAt: overrides.lastUserMessageAt ?? now,
    lastUsage: overrides.lastUsage,
    lastError: overrides.lastError,
  };

  return agent;
}

function createRecord(overrides?: Partial<StoredAgentRecord>): StoredAgentRecord {
  const now = new Date().toISOString();
  return {
    id: "agent-record",
    provider: "claude",
    cwd: "/tmp/project",
    createdAt: now,
    updatedAt: now,
    title: null,
    lastStatus: "idle",
    lastModeId: "plan",
    config: { modeId: "plan", model: "claude-3.5-sonnet" },
    persistence: {
      provider: "claude",
      sessionId: "session-123",
    },
    ...overrides,
  };
}

describe("persistence hooks", () => {
  test("buildConfigOverrides carries systemPrompt and mcpServers", () => {
    const record = createRecord({
      title: "Voice agent (current)",
      config: {
        title: "Voice agent (created)",
        modeId: "default",
        model: "gpt-5.4-mini",
        thinkingOptionId: "minimal",
        systemPrompt: "Use speak first.",
        mcpServers: {
          paseo: {
            type: "stdio",
            command: "node",
            args: ["/tmp/bridge.mjs", "--socket", "/tmp/agent.sock"],
          },
        },
      },
    });

    expect(buildConfigOverrides(record)).toMatchObject({
      cwd: "/tmp/project",
      modeId: "plan",
      model: "gpt-5.4-mini",
      thinkingOptionId: "minimal",
      title: "Voice agent (created)",
      systemPrompt: "Use speak first.",
      mcpServers: {
        paseo: {
          type: "stdio",
          command: "node",
          args: ["/tmp/bridge.mjs", "--socket", "/tmp/agent.sock"],
        },
      },
    });
  });

  test("buildSessionConfig includes persisted systemPrompt and mcpServers", () => {
    const record = createRecord({
      provider: "codex",
      title: "Renamed title",
      config: {
        title: "Creation title",
        modeId: "default",
        model: "gpt-5.4-mini",
        systemPrompt: "Confirm and speak first.",
        mcpServers: {
          paseo: {
            type: "stdio",
            command: "node",
            args: ["/tmp/bridge.mjs", "--socket", "/tmp/agent.sock"],
          },
        },
      },
    });

    expect(buildSessionConfig(record)).toMatchObject({
      provider: "codex",
      cwd: "/tmp/project",
      modeId: "plan",
      model: "gpt-5.4-mini",
      title: "Creation title",
      systemPrompt: "Confirm and speak first.",
      mcpServers: {
        paseo: {
          type: "stdio",
          command: "node",
          args: ["/tmp/bridge.mjs", "--socket", "/tmp/agent.sock"],
        },
      },
    });
  });

  test("buildSessionConfig accepts providers from the canonical manifest", () => {
    const record = createRecord({
      provider: "claude",
      persistence: {
        provider: "claude",
        sessionId: "session-123",
      },
      config: {},
    });

    expect(buildSessionConfig(record)).toMatchObject({
      provider: "claude",
      cwd: "/tmp/project",
    });
  });

  test("buildSessionConfig skips records whose provider is missing from the registry", () => {
    const record = createRecord({
      id: "agent-missing-provider",
      provider: "zai",
    });

    expect(
      buildSessionConfig(record, {
        validProviders: ["claude", "codex"],
        logger: testLogger,
      }),
    ).toBeNull();
    expect(testLogger.warn).toHaveBeenCalledWith(
      { agentId: "agent-missing-provider", provider: "zai" },
      "Skipping persisted agent with unknown provider 'zai'",
    );
  });
});
