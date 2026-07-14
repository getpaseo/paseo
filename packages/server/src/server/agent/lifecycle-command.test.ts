import { describe, expect, test } from "vitest";
import { getParentAgentIdFromLabels, PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  detachAgentCommand,
  setAgentModeCommand,
  updateAgentCommand,
  type LifecycleAgentSnapshot,
  type LifecycleAgentManager,
  type LifecycleAgentStorage,
} from "./lifecycle-command.js";

class FakeLifecycleAgentStorage implements LifecycleAgentStorage {
  readonly records = new Map<string, StoredAgentRecord>();
  readonly upserts: StoredAgentRecord[] = [];

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    return this.records.get(agentId) ?? null;
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    this.upserts.push(record);
    this.records.set(record.id, record);
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
  readonly labelUpdates: Array<{ agentId: string; labels: Record<string, string> }> = [];
  readonly notifiedAgentIds: string[] = [];
  readonly modeUpdates: Array<{ agentId: string; modeId: string }> = [];
  readonly detachedAgentIds: string[] = [];
  inFlightAgentIds = new Set<string>();
  readonly settledDuringCancellationAgentIds = new Set<string>();
  readonly rejectedCancellationAgentIds = new Set<string>();

  constructor(private readonly storage: FakeLifecycleAgentStorage) {}

  getAgent(agentId: string): LifecycleAgentSnapshot | null {
    return this.liveAgents.get(agentId) ?? null;
  }

  hasInFlightRun(agentId: string): boolean {
    return this.inFlightAgentIds.has(agentId);
  }

  async cancelAgentRun(agentId: string) {
    this.cancelledAgentIds.push(agentId);
    if (this.settledDuringCancellationAgentIds.delete(agentId)) {
      this.inFlightAgentIds.delete(agentId);
      return { status: "not_running" } as const;
    }
    if (this.rejectedCancellationAgentIds.has(agentId)) {
      return { status: "refused" } as const;
    }
    return this.inFlightAgentIds.delete(agentId)
      ? ({ status: "settled" } as const)
      : ({ status: "not_running" } as const);
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

  async setLabels(agentId: string, labels: Record<string, string>): Promise<void> {
    this.labelUpdates.push({ agentId, labels });
  }

  async detachAgent(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }> {
    this.detachedAgentIds.push(agentId);
    const existing = this.storage.records.get(agentId);
    if (!existing) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const previousParentAgentId = getParentAgentIdFromLabels(existing.labels);
    if (!previousParentAgentId) {
      return {
        record: existing,
        live: this.liveAgents.has(agentId),
        previousParentAgentId: null,
      };
    }
    const labels = { ...existing.labels };
    delete labels[PARENT_AGENT_ID_LABEL];
    const record = {
      ...existing,
      labels,
      updatedAt: "2026-05-10T10:30:00.000Z",
    };
    this.storage.records.set(agentId, record);
    return {
      record,
      live: this.liveAgents.has(agentId),
      previousParentAgentId,
    };
  }

  notifyAgentState(agentId: string): void {
    this.notifiedAgentIds.push(agentId);
  }

  async setAgentMode(agentId: string, modeId: string) {
    this.modeUpdates.push({ agentId, modeId });
    return null;
  }

  async updateAgentMetadata(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
    },
  ): Promise<void> {
    this.metadataUpdates.push({ agentId, updates });
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

  test("accepts a stop when the run settles during cancellation", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");
    manager.settledDuringCancellationAgentIds.add("agent-1");

    await expect(
      cancelAgentRunCommand({ agentManager: manager, logger }, "agent-1"),
    ).resolves.toEqual({
      agent: manager.liveAgents.get("agent-1"),
      cancelled: false,
    });
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

  test("archives a live agent when its graceful cancellation is rejected", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);
    manager.liveAgents.set("agent-1", managedAgent("agent-1", "running"));
    manager.inFlightAgentIds.add("agent-1");
    manager.rejectedCancellationAgentIds.add("agent-1");
    storage.records.set("agent-1", storedAgent("agent-1"));

    await expect(
      archiveAgentCommand({ agentManager: manager, agentStorage: storage, logger }, "agent-1"),
    ).resolves.toMatchObject({ agentId: "agent-1" });
    expect(manager.cancelledAgentIds).toEqual(["agent-1"]);
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
    storage.records.set("agent-1", storedAgent("agent-1"));
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

    expect(storage.upserts).toHaveLength(0);
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

  test("detaches an agent by clearing only the parent relationship", async () => {
    const storage = new FakeLifecycleAgentStorage();
    storage.records.set("agent-1", {
      ...storedAgent("agent-1"),
      labels: {
        [PARENT_AGENT_ID_LABEL]: "parent-agent",
        team: "infra",
      },
    });
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(detachAgentCommand({ agentManager: manager }, "agent-1")).resolves.toEqual({
      agentId: "agent-1",
      live: false,
      previousParentAgentId: "parent-agent",
      record: {
        ...storedAgent("agent-1"),
        labels: { team: "infra" },
        updatedAt: "2026-05-10T10:30:00.000Z",
      },
    });

    expect(manager.detachedAgentIds).toEqual(["agent-1"]);
  });

  test("detach is accepted when the agent is already detached", async () => {
    const storage = new FakeLifecycleAgentStorage();
    storage.records.set("agent-1", storedAgent("agent-1"));
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(detachAgentCommand({ agentManager: manager }, "agent-1")).resolves.toEqual({
      agentId: "agent-1",
      live: false,
      previousParentAgentId: null,
      record: storedAgent("agent-1"),
    });
  });

  test("sets an agent mode and returns the accepted mode", async () => {
    const storage = new FakeLifecycleAgentStorage();
    const manager = new FakeLifecycleAgentManager(storage);

    await expect(
      setAgentModeCommand({ agentManager: manager }, { agentId: "agent-1", modeId: "plan" }),
    ).resolves.toEqual({ modeId: "plan", notice: null });

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
