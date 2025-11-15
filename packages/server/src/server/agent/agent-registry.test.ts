import { describe, expect, test, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { AgentRegistry } from "./agent-registry.js";
import type { AgentSnapshot } from "./agent-manager.js";

function createSnapshot(overrides?: Partial<AgentSnapshot>): AgentSnapshot {
  const now = new Date();
  return {
    id: "agent-test",
    provider: "claude",
    cwd: "/tmp/project",
    createdAt: now,
    updatedAt: now,
    status: "idle",
    sessionId: null,
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
    ...overrides,
  };
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

  test("persists configs and snapshot metadata", async () => {
    await registry.recordConfig(
      "agent-1",
      "claude",
      "/tmp/project",
      {
        modeId: "coding",
        model: "gpt-5.1",
        extra: { claude: { maxThinkingTokens: 1024 } },
      }
    );

    await registry.applySnapshot(
      createSnapshot({
        id: "agent-1",
        currentModeId: "coding",
        status: "idle",
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

  test("stores titles independently of snapshots", async () => {
    await registry.applySnapshot(
      createSnapshot({
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

  test("recordConfig seeds lastModeId before snapshots", async () => {
    await registry.recordConfig(
      "agent-3",
      "claude",
      "/tmp/project",
      {
        modeId: "plan",
      }
    );

    const record = await registry.get("agent-3");
    expect(record?.lastModeId).toBe("plan");
  });
});
