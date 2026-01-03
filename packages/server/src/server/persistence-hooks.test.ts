import { describe, expect, test, vi } from "vitest";

import type { ManagedAgent } from "./agent/agent-manager.js";
import type { StoredAgentRecord } from "./agent/agent-registry.js";
import {
  attachAgentRegistryPersistence,
} from "./persistence-hooks.js";
import type {
  AgentPermissionRequest,
  AgentSession,
  AgentSessionConfig,
} from "./agent/agent-sdk-types.js";

type ManagedAgentOverrides = Omit<
  Partial<ManagedAgent>,
  "config" | "pendingPermissions" | "session" | "pendingRun"
> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
  session?: AgentSession | null;
  pendingRun?: ManagedAgent["pendingRun"];
};

function createManagedAgent(
  overrides: ManagedAgentOverrides = {}
): ManagedAgent {
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
  const session =
    lifecycle === "closed"
      ? null
      : overrides.session ?? ({} as AgentSession);
  const pendingRun =
    overrides.pendingRun ??
    (lifecycle === "running" ? (async function* noop() {})() : null);

  const agent: ManagedAgent = {
    id: overrides.id ?? "agent-1",
    provider,
    cwd,
    session,
    capabilities:
      overrides.capabilities ??
      {
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
    pendingPermissions:
      overrides.pendingPermissions ??
      new Map<string, AgentPermissionRequest>(),
    pendingRun,
    timeline: overrides.timeline ?? [],
    persistence: overrides.persistence ?? null,
    historyPrimed: overrides.historyPrimed ?? true,
    lastUserMessageAt: overrides.lastUserMessageAt ?? now,
    lastUsage: overrides.lastUsage,
    lastError: overrides.lastError,
  };

  return agent;
}

function createRecord(
  overrides?: Partial<StoredAgentRecord>
): StoredAgentRecord {
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
  test("attachAgentRegistryPersistence forwards agent snapshots", async () => {
    const applySnapshot = vi.fn().mockResolvedValue(undefined);
    let subscriber: (event: any) => void = () => {
      throw new Error("Agent manager subscriber was not registered");
    };
    const agentManager = {
      subscribe: vi.fn((callback: (event: any) => void) => {
        subscriber = callback;
        return () => {
          subscriber = () => {
            throw new Error("Agent manager subscriber was not registered");
          };
        };
      }),
    };
    attachAgentRegistryPersistence(agentManager as any, {
      applySnapshot,
      list: vi.fn(),
    } as any);

    expect(agentManager.subscribe).toHaveBeenCalledTimes(1);
    const agent = createManagedAgent();
    subscriber({ type: "agent_state", agent });
    expect(applySnapshot).toHaveBeenCalledWith(agent);

    subscriber({
      type: "agent_stream",
      agentId: agent.id,
      event: { type: "timeline", item: { type: "assistant_message", text: "hi" } },
    });
    expect(applySnapshot).toHaveBeenCalledTimes(1);
  });
});
