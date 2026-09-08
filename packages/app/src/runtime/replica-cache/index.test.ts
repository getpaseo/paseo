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
    serverId: string;
    kinds: readonly ReplicaRow["kind"][];
    ids?: readonly string[];
  }> = [];
  writes = 0;
  cleanups = 0;
  nextWriteFailure: Error | null = null;
  readGate: Promise<void> | null = null;
  onRead: (() => void) | null = null;

  private key(row: Pick<ReplicaRow, "serverId" | "kind" | "id">): string {
    return `${row.serverId}:${row.kind}:${row.id}`;
  }

  async open(): Promise<void> {}

  async read(
    serverId: string,
    kinds: readonly ReplicaRow["kind"][],
    ids?: readonly string[],
  ): Promise<ReplicaRow[]> {
    this.reads.push({ serverId, kinds, ...(ids ? { ids } : {}) });
    this.onRead?.();
    await this.readGate;
    const acceptedKinds = new Set(kinds);
    const acceptedIds = ids ? new Set(ids) : null;
    return [...this.rows.values()].filter(
      (row) =>
        row.serverId === serverId &&
        acceptedKinds.has(row.kind) &&
        (!acceptedIds || acceptedIds.has(row.id)),
    );
  }

  async readAll(): Promise<ReplicaHostRows[]> {
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
    for (const [key, row] of this.rows) if (row.serverId === serverId) this.rows.delete(key);
  }

  async renameHost(oldServerId: string, newServerId: string): Promise<void> {
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

    expect(await cache.readAgent(SERVER_ID, "agent-1")).toBeUndefined();
    expect(await cache.readWorkspace(SERVER_ID, "workspace-1")).toBeUndefined();
    expect((await cache.readDirectory(SERVER_ID)).projects.size).toBe(0);
  });

  it("fails closed when an accepted deletion cannot be persisted before a read", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();
    storage.nextWriteFailure = new Error("disk busy");

    deleteDirectory(cache, SERVER_ID);

    expect(await cache.readWorkspace(SERVER_ID, "workspace-1")).toBeUndefined();
  });

  it("discards a durable read when the host changes while it is in flight", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();
    const started = deferred();
    const release = deferred();
    storage.onRead = started.resolve;
    storage.readGate = release.promise;

    const reading = cache.readAgent(SERVER_ID, "agent-1");
    await started.promise;
    deleteDirectory(cache, SERVER_ID);
    release.resolve();

    expect(await reading).toBeUndefined();
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

  it("reads one requested agent and the focused timeline without scanning directory rows", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    commitDirectory(writer, SERVER_ID, directory());
    writer.commitTimeline(SERVER_ID, "agent-1", timeline());
    await writer.flush();

    const reader = createCache(storage);
    expect((await reader.readAgent(SERVER_ID, "agent-1"))?.id).toBe("agent-1");
    expect((await reader.readTimeline(SERVER_ID, "agent-1"))?.items).toEqual([timelineItem()]);
    expect(storage.reads).toEqual([
      { serverId: SERVER_ID, kinds: ["agent"], ids: ["agent-1"] },
      { serverId: SERVER_ID, kinds: ["timeline"], ids: ["agent-1"] },
    ]);
  });

  it("reads one requested workspace and its project without scanning the directory", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    commitDirectory(writer, SERVER_ID, directory());
    await writer.flush();

    const reader = createCache(storage);
    const restored = await reader.readWorkspace(SERVER_ID, "workspace-1");

    expect(restored?.workspace.id).toBe("workspace-1");
    expect(restored?.project?.projectId).toBe("project-1");
    expect(storage.reads).toEqual([
      { serverId: SERVER_ID, kinds: ["workspace"], ids: ["workspace-1"] },
      { serverId: SERVER_ID, kinds: ["project"], ids: ["project-1"] },
    ]);
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

    expect(await cache.readAgent(SERVER_ID, "agent-1")).toBeUndefined();
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

    expect(await createCache(storage).readAgent(SERVER_ID, "agent-1")).toBeUndefined();

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

    const restored = await createCache(storage).readDirectory(SERVER_ID);

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

  it("retries a timeline read invalidated by a concurrent directory commit", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    cache.commitTimeline(SERVER_ID, "agent-1", timeline("Persisted timeline"));
    await cache.flush();
    storage.onRead = () => {
      storage.onRead = null;
      commitDirectory(cache, SERVER_ID, directory());
    };

    expect((await cache.readTimeline(SERVER_ID, "agent-1"))?.items).toEqual([
      timelineItem("Persisted timeline"),
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

    await cache.readAgent(SERVER_ID, "missing");
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();

    expect(storage.cleanups).toBe(1);
  });
});
