import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";

import { AgentRegistry } from "./agent-registry.js";
import type { AgentSnapshot } from "./agent-manager.js";

function createSnapshot(overrides?: Partial<AgentSnapshot>): AgentSnapshot {
  const now = new Date();
  return {
    id: "agent-test",
    provider: "claude",
    cwd: "/tmp/project",
    model: null,
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: null,
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
    await registry.applySnapshot(
      createSnapshot({
        id: "agent-1",
        cwd: "/tmp/project",
        currentModeId: "coding",
        status: "idle",
      })
    );

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

  test("recordConfig warns if no snapshot exists", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await registry.recordConfig(
      "agent-3",
      "claude",
      "/tmp/project",
      {
        modeId: "plan",
      }
    );

    const record = await registry.get("agent-3");
    expect(record).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
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
