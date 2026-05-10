import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  setAgentModeCommand,
  updateAgentCommand,
  type LifecycleAgentSnapshot,
  type LifecycleAgentManager,
  type LifecycleAgentStorage,
} from "./lifecycle-command.js";

class FakeLifecycleAgentStorage implements LifecycleAgentStorage {
  readonly records = new Map<string, StoredAgentRecord>();

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    return this.records.get(agentId) ?? null;
  }
}

class FakeLifecycleAgentManager implements LifecycleAgentManager {
  readonly liveAgents = new Map<string, LifecycleAgentSnapshot>();
  readonly cancelledAgentIds: string[] = [];
  readonly clearedAttentionAgentIds: string[] = [];
  readonly archivedAgentIds: string[] = [];
  readonly closedAgentIds: string[] = [];
  readonly metadataUpdates: Array<{
    agentId: string;
    updates: { title?: string; labels?: Record<string, string> };
  }> = [];
  readonly modeUpdates: Array<{ agentId: string; modeId: string }> = [];
  inFlightAgentIds = new Set<string>();

  constructor(private readonly storage: FakeLifecycleAgentStorage) {}

  getAgent(agentId: string): LifecycleAgentSnapshot | null {
    return this.liveAgents.get(agentId) ?? null;
  }

  hasInFlightRun(agentId: string): boolean {
    return this.inFlightAgentIds.has(agentId);
  }

  async cancelAgentRun(agentId: string): Promise<boolean> {
    this.cancelledAgentIds.push(agentId);
    return this.inFlightAgentIds.delete(agentId);
  }

  async clearAgentAttention(agentId: string): Promise<void> {
    this.clearedAttentionAgentIds.push(agentId);
  }

  async archiveAgent(agentId: string): Promise<{ archivedAt: string }> {
    this.archivedAgentIds.push(agentId);
    this.liveAgents.delete(agentId);
    const archivedAt = "2026-05-10T10:00:00.000Z";
    const existing = this.storage.records.get(agentId) ?? storedAgent(agentId);
    this.storage.records.set(agentId, {
      ...existing,
      archivedAt,
    });
    return { archivedAt };
  }

  async archiveSnapshot(agentId: string, archivedAt: string): Promise<StoredAgentRecord> {
    const existing = this.storage.records.get(agentId);
    if (!existing) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const archived = {
      ...existing,
      archivedAt,
    };
    this.storage.records.set(agentId, archived);
    return archived;
  }

  async closeAgent(agentId: string): Promise<void> {
    this.closedAgentIds.push(agentId);
    this.liveAgents.delete(agentId);
  }

  async updateAgentMetadata(
    agentId: string,
    updates: { title?: string; labels?: Record<string, string> },
  ): Promise<void> {
    this.metadataUpdates.push({ agentId, updates });
  }

  async setAgentMode(agentId: string, modeId: string): Promise<void> {
    this.modeUpdates.push({ agentId, modeId });
  }
}

const logger = createTestLogger();

describe("agent lifecycle commands", () => {
  test("cancels only when the agent has an in-flight run", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");

    const result = await cancelAgentRunCommand({ agentManager: manager, logger }, "agent-1");

    expect(result).toEqual({
      agent: manager.liveAgents.get("agent-1"),
      cancelled: true,
    });
    expect(manager.cancelledAgentIds).toEqual(["agent-1"]);
  });

  test("archives a live agent after canceling and clearing attention", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");
    storage.records.set("agent-1", storedAgent("agent-1"));

    const result = await archiveAgentCommand(
      { agentManager: manager, agentStorage: storage, logger },
      "agent-1",
    );

    expect(result).toEqual({
      agentId: "agent-1",
      archivedAt: "2026-05-10T10:00:00.000Z",
      record: {
        ...storedAgent("agent-1"),
        archivedAt: "2026-05-10T10:00:00.000Z",
      },
    });
    expect(manager.cancelledAgentIds).toEqual(["agent-1"]);
    expect(manager.clearedAttentionAgentIds).toEqual(["agent-1"]);
    expect(manager.archivedAgentIds).toEqual(["agent-1"]);
  });

  test("archives a stored agent when no live agent exists", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    storage.records.set("agent-1", storedAgent("agent-1"));

    const result = await archiveAgentCommand(
      { agentManager: manager, agentStorage: storage, logger },
      "agent-1",
    );

    expect(result.agentId).toBe("agent-1");
    expect(result.archivedAt).toEqual(expect.any(String));
    expect(result.record.archivedAt).toBe(result.archivedAt);
    expect(manager.archivedAgentIds).toEqual([]);
  });

  test("normalizes metadata updates and rejects empty updates", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(
      updateAgentCommand(
        { agentManager: manager },
        {
          agentId: "agent-1",
          name: "  Renamed agent  ",
          labels: { team: "infra" },
        },
      ),
    ).resolves.toEqual({ accepted: true, error: null });
    await expect(
      updateAgentCommand({ agentManager: manager }, { agentId: "agent-1", name: "   " }),
    ).resolves.toEqual({
      accepted: false,
      error: "Nothing to update (provide name and/or labels)",
    });

    expect(manager.metadataUpdates).toEqual([
      {
        agentId: "agent-1",
        updates: {
          title: "Renamed agent",
          labels: { team: "infra" },
        },
      },
    ]);
  });

  test("sets an agent mode and returns the accepted mode", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(
      setAgentModeCommand({ agentManager: manager }, { agentId: "agent-1", modeId: "plan" }),
    ).resolves.toEqual({ modeId: "plan" });

    expect(manager.modeUpdates).toEqual([{ agentId: "agent-1", modeId: "plan" }]);
  });
});

function managedAgent(
  id: string,
  lifecycle: LifecycleAgentSnapshot["lifecycle"],
): LifecycleAgentSnapshot {
  return {
    id,
    cwd: "/workspace/project",
    lifecycle,
  };
}

function storedAgent(id: string): StoredAgentRecord {
  return {
    id,
    provider: "codex",
    cwd: "/workspace/project",
    createdAt: "2026-05-10T09:00:00.000Z",
    updatedAt: "2026-05-10T09:00:00.000Z",
    labels: {},
    lastStatus: "closed",
    config: null,
    persistence: null,
    archivedAt: null,
  };
}
