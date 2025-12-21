import { describe, expect, test, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";

import { AgentRegistry } from "./agent-registry.js";
import type { ManagedAgent } from "./agent-manager.js";
import type {
  AgentPermissionRequest,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";

type ManagedAgentOverrides = Omit<
  Partial<ManagedAgent>,
  "config" | "pendingPermissions" | "session" | "pendingRun"
> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
  session?: AgentSession | null;
  pendingRun?: ManagedAgent["pendingRun"];
  runtimeInfo?: ManagedAgent["runtimeInfo"];
  attention?: ManagedAgent["attention"];
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
    model: configOverrides.model ?? "gpt-5.1",
    extra: configOverrides.extra ?? { claude: { maxThinkingTokens: 1024 } },
  };
  const session =
    lifecycle === "closed"
      ? null
      : overrides.session ?? ({} as AgentSession);
  const pendingRun =
    overrides.pendingRun ??
    (lifecycle === "running" ? (async function* noop() {})() : null);

  const agent: ManagedAgent = {
    id: overrides.id ?? "agent-test",
    provider,
    cwd,
    session,
    sessionId: overrides.sessionId ?? "session-123",
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
    attention: overrides.attention ?? { requiresAttention: false },
    runtimeInfo:
      overrides.runtimeInfo ?? {
        provider,
        sessionId: overrides.sessionId ?? "session-123",
        model: config.model ?? null,
        modeId: config.modeId ?? null,
      },
    persistence: overrides.persistence ?? null,
    historyPrimed: overrides.historyPrimed ?? true,
    lastUserMessageAt: overrides.lastUserMessageAt ?? now,
    lastUsage: overrides.lastUsage,
    lastError: overrides.lastError,
  };

  return agent;
}

describe("AgentRegistry", () => {
  let tmpDir: string;
  let filePath: string;
  let registry: AgentRegistry;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-registry-"));
    filePath = path.join(tmpDir, "agents.json");
    registry = new AgentRegistry(filePath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("applySnapshot persists configs and snapshot metadata", async () => {
    await registry.applySnapshot(
      createManagedAgent({
        id: "agent-1",
        cwd: "/tmp/project",
        currentModeId: "coding",
        lifecycle: "idle",
        config: {
          modeId: "coding",
          model: "gpt-5.1",
          extra: { claude: { maxThinkingTokens: 1024 } },
        },
      })
    );

    const records = await registry.list();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.provider).toBe("claude");
    expect(record.config?.modeId).toBe("coding");
    expect(record.config?.model).toBe("gpt-5.1");
    expect(record.lastModeId).toBe("coding");
    expect(record.lastStatus).toBe("idle");

    const reloaded = new AgentRegistry(filePath);
    const [persisted] = await reloaded.list();
    expect(persisted.cwd).toBe("/tmp/project");
    expect(persisted.config?.extra?.claude).toMatchObject({ maxThinkingTokens: 1024 });
  });

  test("applySnapshot preserves original createdAt timestamp", async () => {
    const agentId = "agent-created-at";
    const firstTimestamp = new Date("2025-01-01T00:00:00.000Z");
    await registry.applySnapshot(
      createManagedAgent({ id: agentId, createdAt: firstTimestamp })
    );

    const initialRecord = await registry.get(agentId);
    expect(initialRecord?.createdAt).toBe(firstTimestamp.toISOString());

    await registry.applySnapshot(
      createManagedAgent({
        id: agentId,
        createdAt: new Date("2025-02-01T00:00:00.000Z"),
        updatedAt: new Date("2025-02-01T00:00:00.000Z"),
        lifecycle: "running",
      })
    );

    const updatedRecord = await registry.get(agentId);
    expect(updatedRecord?.createdAt).toBe(firstTimestamp.toISOString());
    expect(updatedRecord?.lastStatus).toBe("running");
  });

  test("stores titles independently of snapshots", async () => {
    await registry.applySnapshot(
      createManagedAgent({
        id: "agent-2",
        provider: "codex",
        cwd: "/tmp/second",
      })
    );
    await registry.setTitle("agent-2", "Fix Login Bug");

    const current = await registry.get("agent-2");
    expect(current?.title).toBe("Fix Login Bug");

    const reloaded = new AgentRegistry(filePath);
    const persisted = await reloaded.get("agent-2");
    expect(persisted?.title).toBe("Fix Login Bug");
  });

  test("setTitle throws when the agent record does not exist", async () => {
    await expect(registry.setTitle("missing-agent", "Impossible"))
      .rejects.toThrow("Agent missing-agent not found");
  });

  test("applySnapshot accepts explicit title overrides", async () => {
    const agentId = "agent-override";
    await registry.applySnapshot(
      createManagedAgent({ id: agentId }),
      { title: "Provided Title" }
    );

    const record = await registry.get(agentId);
    expect(record?.title).toBe("Provided Title");
  });

  test("applySnapshot preserves custom titles while updating metadata", async () => {
    const agentId = "agent-3";
    await registry.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
        currentModeId: "plan",
      })
    );
    await registry.setTitle(agentId, "Important Bug Fix");

    await registry.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        currentModeId: "build",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      })
    );

    const record = await registry.get(agentId);
    expect(record?.title).toBe("Important Bug Fix");
    expect(record?.lastModeId).toBe("build");
    expect(record?.lastStatus).toBe("running");
  });

  test("recovers from trailing garbage in agents.json", async () => {
    const payload = [
      {
        id: "agent-4",
        provider: "claude",
        cwd: "/tmp/project",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        title: "Recovered agent",
        lastStatus: "idle",
        lastModeId: "plan",
        config: null,
        persistence: null,
      },
    ];
    writeFileSync(
      filePath,
      `${JSON.stringify(payload, null, 2)}\nGARBAGE-TRAILING`
    );

    const reloaded = new AgentRegistry(filePath);
    const result = await reloaded.list();
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Recovered agent");

    const sanitized = readFileSync(filePath, "utf8");
    expect(sanitized.includes("GARBAGE-TRAILING")).toBe(false);
  });
});
