import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  type Agent,
} from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { ReplicaCache } from ".";
import type { DirectoryCheckpoint } from "@/runtime/replica-cache";
import type { ReplicaHostRows, ReplicaRow, ReplicaRowChanges, ReplicaRowStore } from "./row-store";

const SERVER_ID = "cached-host";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class MemoryStorage implements ReplicaRowStore {
  readonly rows = new Map<string, ReplicaRow>();
  readonly changes: ReplicaRowChanges[] = [];
  readonly reads: Array<{
    serverIds: readonly string[];
    kinds: readonly ReplicaRow["kind"][];
    ids?: readonly string[];
  }> = [];
  writes = 0;
  readAlls = 0;
  cleanups = 0;
  nextWriteFailure: Error | null = null;
  nextOpenFailure: Error | null = null;
  nextReadAllFailure: Error | null = null;
  nextDeleteFailure: Error | null = null;
  readGate: Promise<void> | null = null;
  readAllGate: Promise<void> | null = null;
  writeGate: Promise<void> | null = null;
  renameGate: Promise<void> | null = null;

  private key(row: Pick<ReplicaRow, "serverId" | "kind" | "id">): string {
    return `${row.serverId}:${row.kind}:${row.id}`;
  }

  async open(): Promise<void> {
    if (this.nextOpenFailure) {
      const error = this.nextOpenFailure;
      this.nextOpenFailure = null;
      throw error;
    }
  }

  async read(
    serverIds: readonly string[],
    kinds: readonly ReplicaRow["kind"][],
    ids?: readonly string[],
  ): Promise<ReplicaRow[]> {
    this.reads.push({ serverIds, kinds, ids });
    const rows = [...this.rows.values()];
    await this.readGate;
    return rows.filter(
      (row) =>
        serverIds.includes(row.serverId) &&
        kinds.includes(row.kind) &&
        (!ids || ids.includes(row.id)),
    );
  }

  async readAll(): Promise<ReplicaHostRows[]> {
    this.readAlls += 1;
    await this.readAllGate;
    if (this.nextReadAllFailure) {
      const error = this.nextReadAllFailure;
      this.nextReadAllFailure = null;
      throw error;
    }
    const hosts = new Map<string, ReplicaRow[]>();
    for (const row of this.rows.values()) {
      const rows = hosts.get(row.serverId) ?? [];
      rows.push(row);
      hosts.set(row.serverId, rows);
    }
    return [...hosts].map(([serverId, rows]) => ({ serverId, rows }));
  }

  async apply(changes: ReplicaRowChanges): Promise<void> {
    this.writes += 1;
    await this.writeGate;
    if (this.nextWriteFailure) {
      const error = this.nextWriteFailure;
      this.nextWriteFailure = null;
      throw error;
    }
    this.changes.push(changes);
    for (const key of changes.deletes) this.rows.delete(this.key(key));
    for (const row of changes.upserts) this.rows.set(this.key(row), row);
  }

  async deleteHost(serverId: string): Promise<void> {
    if (this.nextDeleteFailure) {
      const error = this.nextDeleteFailure;
      this.nextDeleteFailure = null;
      throw error;
    }
    for (const [key, row] of this.rows) if (row.serverId === serverId) this.rows.delete(key);
  }

  async renameHost(oldServerId: string, newServerId: string): Promise<void> {
    await this.renameGate;
    for (const [key, row] of this.rows) {
      if (row.serverId !== oldServerId) continue;
      this.rows.delete(key);
      const renamed = { ...row, serverId: newServerId };
      this.rows.set(this.key(renamed), renamed);
    }
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }
}

const noLegacyCleanup = { clearLegacyCache: async () => undefined };

function createCache(storage: MemoryStorage, maxBytes?: number): ReplicaCache {
  const cache = new ReplicaCache(storage, {
    ...noLegacyCleanup,
    ...(maxBytes ? { maxBytes } : {}),
  });
  cache.setHosts([SERVER_ID]);
  return cache;
}

function agent(id = "agent-1"): Agent {
  return {
    ...normalizeAgentSnapshot(
      {
        id,
        provider: "codex",
        cwd: "/repo/paseo",
        workspaceId: "workspace-1",
        model: null,
        createdAt: "2026-07-18T08:00:00.000Z",
        updatedAt: "2026-07-18T08:01:00.000Z",
        lastUserMessageAt: "2026-07-18T08:01:00.000Z",
        status: "idle",
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
        title: "Cached agent",
        labels: {},
      },
      SERVER_ID,
    ),
    projectPlacement: null,
  };
}

function workspacePayload(): WorkspaceDescriptorPayload {
  return {
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName: "Paseo",
    projectRootPath: "/repo/paseo",
    workspaceDirectory: "/repo/paseo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "running",
    statusEnteredAt: "2026-07-18T08:00:00.000Z",
    activityAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

function timelineItem(text = "Cached"): StreamItem {
  return {
    kind: "assistant_message",
    id: "message-1",
    text,
    timestamp: new Date("2026-07-18T08:02:00.000Z"),
    timelineCursor: { epoch: "epoch-1", seq: 12 },
    source: { startSeq: 12, chunks: [{ seq: 12, offset: 0 }] },
  };
}

function directory(
  checkpoint: DirectoryCheckpoint = { agents: { generation: "g", afterSeq: 12 } },
) {
  const cachedAgent = agent();
  const workspace = normalizeWorkspaceDescriptor(workspacePayload());
  const project = normalizeProjectDescriptor({
    projectId: "project-1",
    projectDisplayName: "Paseo",
    projectRootPath: "/repo/paseo",
    projectKind: "git",
  });
  return {
    agents: new Map([[cachedAgent.id, cachedAgent]]),
    workspaces: new Map([[workspace.id, workspace]]),
    projects: new Map([[project.projectId, project]]),
    checkpoint,
  };
}

function timeline(text = "Cached") {
  return {
    agentId: "agent-1",
    items: [timelineItem(text)],
    range: { epoch: "epoch-1", startSeq: 1, endSeq: 12 },
    hasOlder: true,
  };
}

function commitDirectory(
  cache: ReplicaCache,
  serverId: string,
  value: ReturnType<typeof directory>,
): void {
  cache.commitDirectoryMutations(
    serverId,
    [
      ...Array.from(value.agents.values(), (cachedAgent) => ({
        kind: "agent" as const,
        type: "upsert" as const,
        id: cachedAgent.id,
        value: cachedAgent,
      })),
      ...Array.from(value.workspaces.values(), (workspace) => ({
        kind: "workspace" as const,
        type: "upsert" as const,
        id: workspace.id,
        value: workspace,
      })),
      ...Array.from(value.projects.values(), (project) => ({
        kind: "project" as const,
        type: "upsert" as const,
        id: project.projectId,
        value: project,
      })),
    ],
    value.checkpoint,
  );
}

function deleteDirectory(cache: ReplicaCache, serverId: string): void {
  cache.commitDirectoryMutations(serverId, [
    { kind: "agent", type: "delete", id: "agent-1" },
    { kind: "workspace", type: "delete", id: "workspace-1" },
    { kind: "project", type: "delete", id: "project-1" },
  ]);
}

describe("ReplicaCache", () => {
  it("paints requested rows while the unrelated global index is unavailable", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    commitDirectory(writer, SERVER_ID, directory());
    writer.commitTimeline(SERVER_ID, "agent-1", timeline("Requested"));
    await writer.flush();
    const release = deferred();
    storage.readAllGate = release.promise;
    storage.reads.length = 0;
    const reader = createCache(storage);
    reader.setHosts([SERVER_ID, "unrelated"]);
    reader.commitTimeline("unrelated", "other", { ...timeline("Pending"), agentId: "other" });
    const writing = reader.flush();
    let painted = false;
    const reading = Promise.all([
      reader.readTimeline(SERVER_ID, "agent-1"),
      reader.readDirectory(SERVER_ID),
    ]).then(([saved, restoredDirectory]) => {
      expect(saved?.items).toEqual([timelineItem("Requested")]);
      expect(restoredDirectory.agents.has("agent-1")).toBe(true);
      painted = true;
      return undefined;
    });
    try {
      await expect.poll(() => painted, { timeout: 200 }).toBe(true);
      expect(storage.reads).toEqual([
        { serverIds: [SERVER_ID], kinds: ["timeline"], ids: ["agent-1"] },
        {
          serverIds: [SERVER_ID],
          kinds: ["agent", "workspace", "project", "checkpoint"],
          ids: undefined,
        },
      ]);
    } finally {
      release.resolve();
      await Promise.all([writing, reading]);
    }
  });

  it("overlays a commit that settles after a scoped read captures old disk rows", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    writer.commitTimeline(SERVER_ID, "agent-1", timeline("Old"));
    await writer.flush();
    const reader = createCache(storage);
    const release = deferred();
    storage.readGate = release.promise;
    const reading = reader.readTimeline(SERVER_ID, "agent-1");
    await expect.poll(() => storage.reads.length).toBe(1);
    reader.commitTimeline(SERVER_ID, "agent-1", timeline("New"));
    await reader.flush();
    release.resolve();
    expect((await reading)?.items).toEqual([timelineItem("New")]);
  });

  it("invalidates an old scoped read across removal and immediate re-registration", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    writer.commitTimeline(SERVER_ID, "agent-1", timeline("Old lifetime"));
    await writer.flush();
    const reader = createCache(storage);
    const release = deferred();
    storage.readGate = release.promise;
    const reading = reader.readTimeline(SERVER_ID, "agent-1");
    await expect.poll(() => storage.reads.length).toBe(1);
    reader.setHosts([]);
    reader.setHosts([SERVER_ID]);
    release.resolve();
    expect(await reading).toBeUndefined();
    expect(await reader.readTimeline(SERVER_ID, "agent-1")).toBeUndefined();
    await reader.flush();
  });

  it.each([false, true])(
    "uses the same certification for accepted and persisted rows (provenance=%s)",
    async (provenance) => {
      const storage = new MemoryStorage();
      const cache = createCache(storage);
      const items = ["block-1", "block-2"].map((id) => {
        const item = timelineItem("Repeated markdown");
        item.id = id;
        if (item.kind === "assistant_message") item.messageId = "same-message";
        item.source = provenance ? { startSeq: 12, chunks: [{ seq: 12, offset: 0 }] } : undefined;
        return item;
      });
      const value = { ...timeline(), items };
      cache.commitTimeline(SERVER_ID, "agent-1", value);
      const accepted = await cache.readTimeline(SERVER_ID, "agent-1");
      expect(accepted?.range).toEqual(provenance ? value.range : null);
      expect(accepted?.items).toEqual(items);
      await cache.flush();
      const persisted = await createCache(storage).readTimeline(SERVER_ID, "agent-1");
      expect(persisted).toEqual(accepted);
    },
  );

  it("serializes only the coalesced certified page, including reads of accepted commits", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    let encodings = 0;
    class MeasuredDate extends Date {
      override toISOString(): string {
        encodings += 1;
        return super.toISOString();
      }
    }
    for (let seq = 1; seq <= 10; seq++) {
      const item = {
        ...timelineItem(`row ${seq}`),
        timestamp: new MeasuredDate("2026-07-18T08:02:00.000Z"),
        timelineCursor: { epoch: "epoch", seq },
        source: { startSeq: seq, chunks: [{ seq, offset: 0 }] },
      };
      cache.commitTimeline(
        SERVER_ID,
        "agent-1",
        {
          agentId: "agent-1",
          items: [item],
          range: { epoch: "epoch", startSeq: seq, endSeq: seq },
          hasOlder: true,
        },
        true,
      );
      expect((await cache.readTimeline(SERVER_ID, "agent-1"))?.items).toEqual([item]);
    }
    expect(encodings).toBe(0);
    await cache.flush();
    expect(encodings).toBe(1);
    expect((await createCache(storage).readTimeline(SERVER_ID, "agent-1"))?.range?.endSeq).toBe(10);
  });

  it("does not resurrect a removed host when its in-flight write completes", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    const release = deferred();
    storage.writeGate = release.promise;
    cache.commitTimeline(SERVER_ID, "agent-1", timeline("Removed history"));
    const writing = cache.flush();
    await expect.poll(() => storage.writes).toBe(1);
    cache.setHosts([]);
    release.resolve();
    await writing;
    cache.setHosts([SERVER_ID]);
    await cache.flush();
    expect(await cache.readTimeline(SERVER_ID, "agent-1")).toBeUndefined();
    expect(storage.rows.size).toBe(0);
  });

  it("keeps rows written under a host renamed during their write", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    const release = deferred();
    storage.writeGate = release.promise;
    cache.commitTimeline(SERVER_ID, "agent-1", timeline("Renamed while writing"));
    const writing = cache.flush();
    await expect.poll(() => storage.writes).toBe(1);
    cache.reconcileServerId(SERVER_ID, "resolved-host");
    release.resolve();
    await writing;
    await cache.flush();

    expect((await cache.readTimeline("resolved-host", "agent-1"))?.items).toEqual([
      timelineItem("Renamed while writing"),
    ]);
    expect(await cache.readTimeline(SERVER_ID, "agent-1")).toBeUndefined();
    expect([...storage.rows.keys()]).toEqual(["resolved-host:timeline:agent-1"]);
  });

  it("writes a row replaced during its own write again", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    const release = deferred();
    storage.writeGate = release.promise;
    cache.commitTimeline(SERVER_ID, "agent-1", timeline("First"));
    const writing = cache.flush();
    await expect.poll(() => storage.writes).toBe(1);
    cache.commitTimeline(SERVER_ID, "agent-1", timeline("Second"));
    release.resolve();
    await writing;
    await cache.flush();

    expect(storage.writes).toBe(2);
    expect((await createCache(storage).readTimeline(SERVER_ID, "agent-1"))?.items).toEqual([
      timelineItem("Second"),
    ]);
  });

  it("restores a timeline while another host's disk write is blocked", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    cache.setHosts([SERVER_ID, "other-host"]);
    cache.commitTimeline(SERVER_ID, "agent-1", timeline("Saved before restart"));
    await cache.flush();
    const release = deferred();
    storage.writeGate = release.promise;
    commitDirectory(cache, "other-host", directory());
    const writing = cache.flush();
    await expect.poll(() => storage.writes).toBe(2);
    let restored: Awaited<ReturnType<ReplicaCache["readTimeline"]>>;
    const reading = cache.readTimeline(SERVER_ID, "agent-1").then((value) => {
      restored = value;
      return value;
    });
    try {
      await expect
        .poll(() => restored?.items, { timeout: 200 })
        .toEqual([timelineItem("Saved before restart")]);
    } finally {
      release.resolve();
      await Promise.all([writing, reading]);
    }
  });

  it("reads rows under a resolved host identity before the disk rename finishes", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    writer.commitTimeline(SERVER_ID, "agent-1", timeline("Saved under temporary host ID"));
    await writer.flush();
    const reader = createCache(storage);
    const release = deferred();
    storage.renameGate = release.promise;
    reader.reconcileServerId(SERVER_ID, "resolved-host");
    expect((await reader.readTimeline("resolved-host", "agent-1"))?.items).toEqual([
      timelineItem("Saved under temporary host ID"),
    ]);
    release.resolve();
    await reader.flush();
    expect(storage.rows.has("resolved-host:timeline:agent-1")).toBe(true);
  });

  it("keeps rename collision precedence and accepted baselines during lazy reads", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    writer.setHosts([SERVER_ID, "resolved-host"]);
    writer.commitTimeline(SERVER_ID, "agent-1", timeline("Moved"));
    writer.commitTimeline("resolved-host", "agent-1", timeline("Superseded target"));
    commitDirectory(writer, SERVER_ID, directory());
    await writer.flush();
    const reader = createCache(storage);
    reader.setHosts([SERVER_ID, "resolved-host"]);
    const release = deferred();
    storage.renameGate = release.promise;
    reader.replaceDirectoryBaseline(SERVER_ID, {
      ...directory(),
      workspaces: new Map(),
      projects: new Map(),
    });
    reader.reconcileServerId(SERVER_ID, "resolved-host");
    try {
      expect((await reader.readTimeline("resolved-host", "agent-1"))?.items).toEqual([
        timelineItem("Moved"),
      ]);
      const accepted = await reader.readDirectory("resolved-host");
      expect(accepted.agents.get("agent-1")?.serverId).toBe("resolved-host");
      expect(accepted.workspaces.size).toBe(0);
    } finally {
      release.resolve();
      await reader.flush();
    }
    const reopened = new ReplicaCache(storage, noLegacyCleanup);
    reopened.setHosts(["resolved-host"]);
    expect((await reopened.readDirectory("resolved-host")).workspaces.size).toBe(0);
    expect((await reopened.readTimeline("resolved-host", "agent-1"))?.items).toEqual([
      timelineItem("Moved"),
    ]);
  });

  it("returns a committed timeline before it is written", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    cache.commitTimeline(SERVER_ID, "agent-1", timeline("Accepted"));

    expect((await cache.readTimeline(SERVER_ID, "agent-1"))?.items).toEqual([
      timelineItem("Accepted"),
    ]);
    expect(storage.writes).toBe(0);
  });

  it("round-trips a row's source start and chunk provenance", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    cache.commitTimeline(SERVER_ID, "agent-1", {
      ...timeline(),
      items: [
        {
          ...timelineItem("Streamed"),
          source: {
            startSeq: 10,
            chunks: [
              { seq: 10, offset: 0 },
              { seq: 12, offset: 4 },
            ],
          },
        },
      ],
    });
    await cache.flush();

    const restored = await createCache(storage).readTimeline(SERVER_ID, "agent-1");
    expect(restored?.items[0]).toMatchObject({ source: { startSeq: 10 } });
    expect(restored?.items[0]?.source?.chunks).toEqual([
      { seq: 10, offset: 0 },
      { seq: 12, offset: 4 },
    ]);
  });

  it("persists the owner's forty-entry restart page from a long synced history", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    const items = Array.from({ length: 40 }, (_, index) => ({
      ...timelineItem(`Message ${index}`),
      id: `message-${index}`,
      timelineCursor: { epoch: "epoch-1", seq: index + 201 },
      source: { startSeq: index + 201, chunks: [{ seq: index + 201, offset: 0 }] },
    }));
    cache.commitTimeline(SERVER_ID, "agent-1", {
      agentId: "agent-1",
      items,
      range: { epoch: "epoch-1", startSeq: 201, endSeq: 240 },
      hasOlder: true,
    });
    await cache.flush();

    const restored = await createCache(storage).readTimeline(SERVER_ID, "agent-1");
    expect(restored?.items).toHaveLength(40);
    expect(restored?.range).toEqual({ epoch: "epoch-1", startSeq: 201, endSeq: 240 });
    expect(restored?.hasOlder).toBe(true);
  });

  it("encodes the owner's certified page without a per-timeline byte ceiling", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    const items = Array.from({ length: 40 }, (_, index) => ({
      ...timelineItem("x".repeat(20_000)),
      id: `message-${index}`,
      timelineCursor: { epoch: "epoch-1", seq: index + 1 },
      source: { startSeq: index + 1, chunks: [{ seq: index + 1, offset: 0 }] },
    }));
    cache.commitTimeline(SERVER_ID, "agent-1", {
      agentId: "agent-1",
      items,
      range: { epoch: "epoch-1", startSeq: 1, endSeq: 40 },
      hasOlder: true,
    });
    await cache.flush();

    const restored = await createCache(storage).readTimeline(SERVER_ID, "agent-1");
    expect(restored?.items.map((item) => item.id)).toEqual(items.map((item) => item.id));
    expect(restored?.range).toEqual({ epoch: "epoch-1", startSeq: 1, endSeq: 40 });
    expect(restored?.hasOlder).toBe(true);
  });

  it("does nothing until an owner explicitly commits data", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);

    await cache.flush();

    expect(storage.writes).toBe(0);
    expect(storage.rows.size).toBe(0);
  });

  it("round-trips explicit directory and timeline commits", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    commitDirectory(writer, SERVER_ID, directory());
    writer.commitTimeline(SERVER_ID, "agent-1", timeline());
    await writer.flush();

    const reader = createCache(storage);
    const restoredDirectory = await reader.readDirectory(SERVER_ID);
    const restoredTimeline = await reader.readTimeline(SERVER_ID, "agent-1");

    expect(restoredDirectory.agents.get("agent-1")?.title).toBe("Cached agent");
    expect(restoredDirectory.workspaces.get("workspace-1")?.name).toBe("main");
    expect(restoredDirectory.projects.get("project-1")?.projectDisplayName).toBe("Paseo");
    expect(restoredDirectory.checkpoint).toEqual({ agents: { generation: "g", afterSeq: 12 } });
    expect(restoredTimeline).toEqual(timeline());
  });

  it("preserves pending timeline updates across directory baseline replacement", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    writer.commitTimeline(SERVER_ID, "agent-1", timeline("Latest visible reply"));
    writer.replaceDirectoryBaseline(SERVER_ID, directory());
    await writer.flush();

    const reader = createCache(storage);
    expect(await reader.readTimeline(SERVER_ID, "agent-1")).toEqual(
      timeline("Latest visible reply"),
    );
  });

  it("preserves clearing a timeline across directory baseline replacement", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    writer.commitTimeline(SERVER_ID, "agent-1", timeline());
    await writer.flush();
    writer.commitTimeline(SERVER_ID, "agent-1", { ...timeline(), items: [], range: null });
    writer.replaceDirectoryBaseline(SERVER_ID, directory());
    await writer.flush();

    const reader = createCache(storage);
    expect(await reader.readTimeline(SERVER_ID, "agent-1")).toEqual({
      ...timeline(),
      items: [],
      range: null,
      hasOlder: false,
    });
  });

  it("serializes and writes only keyed directory mutations", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    const changed = agent("changed-agent");
    let titleReads = 0;
    Object.defineProperty(changed, "title", {
      configurable: true,
      enumerable: true,
      get: () => {
        titleReads += 1;
        return "Changed agent";
      },
    });

    cache.commitDirectoryMutations(
      SERVER_ID,
      [{ kind: "agent", type: "upsert", id: changed.id, value: changed }],
      { agents: { generation: "g", afterSeq: 13 } },
    );

    expect(titleReads).toBe(0);
    await cache.flush();
    expect(titleReads).toBe(1);
    expect(storage.changes).toHaveLength(1);
    expect(storage.changes[0]?.upserts.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: "agent", id: "changed-agent" },
      { kind: "checkpoint", id: "singleton" },
    ]);
    expect(storage.changes[0]?.deletes).toEqual([]);
  });

  it("round-trips identified and anonymous open turns without changing protocol status", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    const identified = agent("identified");
    identified.turn = {
      phase: "open",
      turnId: "turn-1",
      startedAt: new Date("2026-08-31T12:00:00.000Z"),
      cancellationRequestId: null,
    };
    const anonymous = agent("anonymous");
    anonymous.turn = {
      phase: "open",
      turnId: null,
      startedAt: null,
      cancellationRequestId: null,
    };
    writer.commitDirectoryMutations(SERVER_ID, [
      { kind: "agent", type: "upsert", id: identified.id, value: identified },
      { kind: "agent", type: "upsert", id: anonymous.id, value: anonymous },
    ]);
    await writer.flush();

    const restored = await createCache(storage).readDirectory(SERVER_ID);

    expect(restored.agents.get("identified")).toMatchObject({
      status: "idle",
      turn: {
        phase: "open",
        turnId: "turn-1",
        startedAt: new Date("2026-08-31T12:00:00.000Z"),
        cancellationRequestId: null,
      },
    });
    expect(restored.agents.get("anonymous")).toMatchObject({
      status: "idle",
      turn: {
        phase: "open",
        turnId: null,
        startedAt: null,
        cancellationRequestId: null,
      },
    });
  });

  it("coalesces timeline values before serialization", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    let textReads = 0;
    const changedTimeline = timeline();
    Object.defineProperty(changedTimeline.items[0], "text", {
      configurable: true,
      enumerable: true,
      get: () => {
        textReads += 1;
        return "Latest";
      },
    });

    cache.commitTimeline(SERVER_ID, "agent-1", timeline("Old"));
    cache.commitTimeline(SERVER_ID, "agent-1", changedTimeline);

    expect(textReads).toBe(0);
    await cache.flush();
    expect(textReads).toBe(1);
    expect(storage.changes[0]?.upserts.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: "timeline", id: "agent-1" },
    ]);
  });

  it("never reads directory rows older than an accepted deferred deletion", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();

    deleteDirectory(cache, SERVER_ID);

    const restored = await cache.readDirectory(SERVER_ID);
    expect(restored.agents.size).toBe(0);
    expect(restored.workspaces.size).toBe(0);
    expect(restored.projects.size).toBe(0);
  });

  it("fails closed when an accepted deletion cannot be persisted before a read", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();
    storage.nextWriteFailure = new Error("disk busy");

    deleteDirectory(cache, SERVER_ID);

    expect((await cache.readDirectory(SERVER_ID)).workspaces.size).toBe(0);
  });

  it("applies a deletion accepted while a scoped directory read is still loading", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    commitDirectory(writer, SERVER_ID, directory());
    await writer.flush();
    const release = deferred();
    storage.readGate = release.promise;
    const cache = createCache(storage);

    const reading = cache.readDirectory(SERVER_ID);
    deleteDirectory(cache, SERVER_ID);
    release.resolve();

    expect((await reading).agents.size).toBe(0);
  });

  it("never reads a timeline older than an accepted deferred replacement", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    cache.commitTimeline(SERVER_ID, "agent-1", timeline("Old"));
    await cache.flush();

    cache.commitTimeline(SERVER_ID, "agent-1", timeline("New"));

    expect((await cache.readTimeline(SERVER_ID, "agent-1"))?.items).toEqual([timelineItem("New")]);
  });

  it("round-trips plugin timeline items", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    const pluginItem: StreamItem = {
      kind: "plugin",
      id: "reports/test-report/1",
      pluginId: "reports",
      pluginItemId: "test-report/1",
      itemKind: "test-report",
      version: 1,
      data: { passed: 4, failed: 0 },
      timestamp: new Date("2026-07-18T08:02:00.000Z"),
      timelineCursor: { epoch: "epoch-1", seq: 12 },
    };
    writer.commitTimeline(SERVER_ID, "agent-1", {
      agentId: "agent-1",
      items: [pluginItem],
      range: { epoch: "epoch-1", startSeq: 12, endSeq: 12 },
      hasOlder: true,
    });
    await writer.flush();

    const reader = createCache(storage);
    expect((await reader.readTimeline(SERVER_ID, "agent-1"))?.items).toEqual([pluginItem]);
  });

  it("drops cached plugin timeline items without a plugin-local id", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    const pluginItem = {
      kind: "plugin",
      id: "reports/test-report/1",
      pluginId: "reports",
      pluginItemId: "test-report/1",
      itemKind: "test-report",
      version: 1,
      data: { passed: 4 },
      timestamp: new Date("2026-07-18T08:02:00.000Z"),
    } satisfies StreamItem;
    writer.commitTimeline(SERVER_ID, "agent-1", {
      agentId: "agent-1",
      items: [pluginItem],
      range: { epoch: "epoch-1", startSeq: 12, endSeq: 12 },
      hasOlder: true,
    });
    await writer.flush();
    const row = [...storage.rows.values()].find((candidate) => candidate.kind === "timeline");
    if (!row) throw new Error("timeline row was not written");
    const payload = JSON.parse(row.payload) as { items: Array<Record<string, unknown>> };
    delete payload.items[0]?.pluginItemId;
    storage.rows.set(`${row.serverId}:${row.kind}:${row.id}`, {
      ...row,
      payload: JSON.stringify(payload),
    });

    expect(await createCache(storage).readTimeline(SERVER_ID, "agent-1")).toBeUndefined();
  });

  it("treats a corrupt row as a scoped miss", async () => {
    const storage = new MemoryStorage();
    storage.rows.set(`${SERVER_ID}:agent:agent-1`, {
      serverId: SERVER_ID,
      kind: "agent",
      id: "agent-1",
      payload: "{bad",
    });
    storage.rows.set(`${SERVER_ID}:project:project-1`, {
      serverId: SERVER_ID,
      kind: "project",
      id: "project-1",
      payload: JSON.stringify({
        projectId: "project-1",
        projectDisplayName: "Paseo",
        projectCustomName: null,
        projectCustomIconRevision: null,
        projectRootPath: "/repo/paseo",
        projectKind: "git",
      }),
    });
    const cache = createCache(storage);

    const restored = await cache.readDirectory(SERVER_ID);
    await cache.flush();

    expect(restored.agents.size).toBe(0);
    expect(restored.projects.get("project-1")?.projectDisplayName).toBe("Paseo");
    expect(storage.rows.has(`${SERVER_ID}:agent:agent-1`)).toBe(false);
    expect(storage.rows.has(`${SERVER_ID}:project:project-1`)).toBe(true);
  });

  it("removes a targeted corrupt row from eviction bookkeeping", async () => {
    const otherServerId = "other-host";
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage, noLegacyCleanup);
    writer.setHosts([SERVER_ID, otherServerId]);
    commitDirectory(writer, SERVER_ID, directory());
    writer.commitTimeline(SERVER_ID, "agent-1", timeline());
    commitDirectory(writer, otherServerId, directory());
    await writer.flush();
    storage.rows.set(`${SERVER_ID}:agent:agent-1`, {
      serverId: SERVER_ID,
      kind: "agent",
      id: "agent-1",
      payload: `{${"x".repeat(5_000)}`,
    });
    const initialBytes = [...storage.rows.values()].reduce(
      (total, row) => total + Buffer.byteLength(row.payload),
      0,
    );
    const cache = new ReplicaCache(storage, { ...noLegacyCleanup, maxBytes: initialBytes + 100 });
    cache.setHosts([SERVER_ID, otherServerId]);
    commitDirectory(cache, otherServerId, directory());
    await cache.flush();

    expect((await cache.readDirectory(SERVER_ID)).agents.has("agent-1")).toBe(false);
    cache.commitTimeline(otherServerId, "agent-1", timeline("x".repeat(1_000)));
    await cache.flush();

    expect(storage.rows.has(`${SERVER_ID}:timeline:agent-1`)).toBe(true);
  });

  it("atomically removes a targeted corrupt row and its matching persisted cursor", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    commitDirectory(
      writer,
      SERVER_ID,
      directory({
        agents: { generation: "g", afterSeq: 12 },
        projects: { generation: "g", afterSeq: 4 },
      }),
    );
    await writer.flush();
    storage.rows.set(`${SERVER_ID}:agent:agent-1`, {
      serverId: SERVER_ID,
      kind: "agent",
      id: "agent-1",
      payload: "{bad",
    });

    const cache = createCache(storage);
    expect((await cache.readDirectory(SERVER_ID)).agents.has("agent-1")).toBe(false);
    await cache.flush();

    expect(storage.changes.at(-1)).toMatchObject({
      deletes: [{ serverId: SERVER_ID, kind: "agent", id: "agent-1" }],
      upserts: [{ serverId: SERVER_ID, kind: "checkpoint", id: "singleton" }],
    });
    expect((await createCache(storage).readDirectory(SERVER_ID)).checkpoint).toEqual({
      projects: { generation: "g", afterSeq: 4 },
    });
  });

  it("drops only the cursor whose cached entity baseline is corrupt", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    commitDirectory(
      writer,
      SERVER_ID,
      directory({
        agents: { generation: "g", afterSeq: 12 },
        projects: { generation: "g", afterSeq: 4 },
      }),
    );
    await writer.flush();
    storage.rows.set(`${SERVER_ID}:agent:agent-1`, {
      serverId: SERVER_ID,
      kind: "agent",
      id: "agent-1",
      payload: "{bad",
    });

    const cache = createCache(storage);
    const restored = await cache.readDirectory(SERVER_ID);
    await cache.flush();

    expect(restored.checkpoint).toEqual({
      projects: { generation: "g", afterSeq: 4 },
    });
    expect(storage.changes.at(-1)).toMatchObject({
      deletes: [{ serverId: SERVER_ID, kind: "agent", id: "agent-1" }],
      upserts: [{ serverId: SERVER_ID, kind: "checkpoint", id: "singleton" }],
    });
    const reopened = await createCache(storage).readDirectory(SERVER_ID);
    expect(reopened.checkpoint).toEqual({
      projects: { generation: "g", afterSeq: 4 },
    });
  });

  it("commits directory rows and their checkpoint in one storage transaction", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);

    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();

    expect(storage.changes).toHaveLength(1);
    expect(storage.changes[0]?.upserts.map((row) => row.kind).sort()).toEqual([
      "agent",
      "checkpoint",
      "project",
      "workspace",
    ]);
  });

  it.each(["nextOpenFailure", "nextReadAllFailure"] as const)(
    "persists an accepted commit automatically after %s",
    async (failure) => {
      const storage = new MemoryStorage();
      const cache = createCache(storage);
      storage[failure] = new Error("storage busy");
      cache.commitTimeline(SERVER_ID, "agent-1", timeline("Retry me"));

      await cache.flush();
      expect(storage.rows.size).toBe(0);
      expect(await cache.readTimeline(SERVER_ID, "agent-1")).toEqual(timeline("Retry me"));
      await expect.poll(() => storage.rows.size, { timeout: 2500 }).toBe(1);

      const reopened = createCache(storage);
      expect(await reopened.readTimeline(SERVER_ID, "agent-1")).toEqual(timeline("Retry me"));
    },
  );

  it("recovers a partial index load with queued host changes and the exact surviving budget", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    writer.setHosts([SERVER_ID, "stale", "old", "removed"]);
    for (const host of [SERVER_ID, "stale", "old", "removed"]) {
      writer.commitTimeline(host, "agent-1", timeline("Stored"));
    }
    await writer.flush();
    const survivorBytes = [...storage.rows.values()]
      .filter((row) => row.serverId === SERVER_ID || row.serverId === "old")
      .reduce((bytes, row) => bytes + Buffer.byteLength(row.payload), 0);
    const cache = createCache(storage, survivorBytes);
    cache.setHosts([SERVER_ID, "old", "removed"]);
    const release = deferred();
    storage.readAllGate = release.promise;
    storage.nextDeleteFailure = new Error("stale host cleanup busy");
    const loadsBefore = storage.readAlls;
    cache.commitTimeline(SERVER_ID, "agent-1", timeline("Newest"));
    const writing = cache.flush();
    try {
      await expect.poll(() => storage.readAlls).toBe(loadsBefore + 1);
      cache.reconcileServerId("old", "renamed");
      cache.setHosts([SERVER_ID, "renamed"]);
    } finally {
      release.resolve();
      await writing;
    }
    expect(await cache.readTimeline(SERVER_ID, "agent-1")).toEqual(timeline("Newest"));
    expect(await cache.readTimeline("renamed", "agent-1")).toEqual(timeline("Stored"));
    expect(await cache.readTimeline("removed", "agent-1")).toBeUndefined();
    await expect.poll(() => storage.changes.length, { timeout: 2500 }).toBe(2);

    const reopened = createCache(storage);
    reopened.setHosts([SERVER_ID, "renamed"]);
    expect([...storage.rows.values()].map((row) => row.serverId).sort()).toEqual([
      SERVER_ID,
      "renamed",
    ]);
    expect(await reopened.readTimeline(SERVER_ID, "agent-1")).toEqual(timeline("Newest"));
    expect(await reopened.readTimeline("renamed", "agent-1")).toEqual(timeline("Stored"));
  });

  it("retries an explicit commit after a storage failure", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    storage.nextWriteFailure = new Error("disk busy");
    cache.commitTimeline(SERVER_ID, "agent-1", timeline("Retry me"));

    await cache.flush();
    expect(storage.rows.size).toBe(0);
    await cache.flush();

    expect((await cache.readTimeline(SERVER_ID, "agent-1"))?.items).toEqual([
      timelineItem("Retry me"),
    ]);
  });

  it("rebuilds every directory row before restoring its checkpoint after eviction", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage, { ...noLegacyCleanup, maxBytes: 2_500 });
    cache.setHosts([SERVER_ID, "other-host"]);
    const cachedDirectory = directory();
    commitDirectory(cache, SERVER_ID, cachedDirectory);
    await cache.flush();
    commitDirectory(cache, "other-host", cachedDirectory);
    await cache.flush();
    expect([...storage.rows.values()].some((row) => row.serverId === SERVER_ID)).toBe(false);

    cache.commitDirectoryMutations(
      SERVER_ID,
      [{ kind: "agent", type: "upsert", id: "agent-1", value: agent() }],
      { agents: { generation: "new-generation", afterSeq: 99 } },
    );
    await cache.flush();

    expect([...storage.rows.values()].some((row) => row.serverId === SERVER_ID)).toBe(false);
    expect((await cache.readDirectory(SERVER_ID)).checkpoint).toBeUndefined();

    cache.replaceDirectoryBaseline(SERVER_ID, cachedDirectory);
    await cache.flush();

    expect(
      [...storage.rows.values()]
        .filter((row) => row.serverId === SERVER_ID)
        .map((row) => row.kind)
        .sort(),
    ).toEqual(["agent", "checkpoint", "project", "workspace"]);
  });

  it("runs legacy cleanup once when storage is first used", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage, {
      clearLegacyCache: async () => {
        storage.cleanups += 1;
      },
    });
    cache.setHosts([SERVER_ID]);

    await cache.readTimeline(SERVER_ID, "missing");
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();

    expect(storage.cleanups).toBe(1);
  });
});
