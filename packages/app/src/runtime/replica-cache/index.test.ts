import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  selectAgentTimelineState,
  useSessionStore,
} from "@/stores/session-store";
import { createUserMessage, type StreamItem } from "@/types/stream";
import { ReplicaCache } from ".";
import type { ReplicaHostRows, ReplicaRow, ReplicaRowChanges, ReplicaRowStore } from "./row-store";

const SERVER_ID = "cached-host";
const LRU_SERVER_IDS = ["host-a", "host-b", "host-c"] as const;

class MemoryStorage implements ReplicaRowStore {
  readonly rows = new Map<string, ReplicaRow>();
  readonly changes: ReplicaRowChanges[] = [];
  readonly deletedHosts: string[] = [];
  readonly renamedHosts: Array<{ oldServerId: string; newServerId: string }> = [];
  writes = 0;
  clears = 0;

  private key(row: Pick<ReplicaRow, "serverId" | "kind" | "id">): string {
    return `${row.serverId}:${row.kind}:${row.id}`;
  }

  async open(): Promise<void> {}

  async readAll(): Promise<ReplicaHostRows[]> {
    const hosts = new Map<string, ReplicaRow[]>();
    for (const row of this.rows.values()) {
      const rows = hosts.get(row.serverId) ?? [];
      rows.push(row);
      hosts.set(row.serverId, rows);
    }
    return Array.from(hosts, ([serverId, rows]) => ({ serverId, rows }));
  }

  async apply(changes: ReplicaRowChanges): Promise<void> {
    this.writes += 1;
    this.changes.push(changes);
    for (const key of changes.deletes) this.rows.delete(this.key(key));
    for (const row of changes.upserts) this.rows.set(this.key(row), row);
  }

  async deleteHost(serverId: string): Promise<void> {
    this.deletedHosts.push(serverId);
    for (const [key, row] of this.rows) if (row.serverId === serverId) this.rows.delete(key);
  }

  async renameHost(oldServerId: string, newServerId: string): Promise<void> {
    this.renamedHosts.push({ oldServerId, newServerId });
    for (const [key, row] of this.rows) {
      if (row.serverId !== oldServerId) continue;
      this.rows.delete(key);
      const renamed = { ...row, serverId: newServerId };
      this.rows.set(this.key(renamed), renamed);
    }
  }

  async clear(): Promise<void> {
    this.clears += 1;
    this.rows.clear();
  }
}

const NO_LEGACY_CLEANUP = { clearLegacyCache: async () => undefined };

function cache(storage: MemoryStorage, options: { maxBytes?: number } = {}): ReplicaCache {
  return new ReplicaCache(storage, { ...options, ...NO_LEGACY_CLEANUP });
}

function workspace(
  id = "workspace-1",
  projectId = "project-1",
  workspaceDirectory = "/repo/paseo",
): WorkspaceDescriptorPayload {
  return {
    id,
    projectId,
    projectDisplayName: "Paseo",
    projectRootPath: workspaceDirectory,
    workspaceDirectory,
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

function agent(id: string, workspaceId = "workspace-1", cwd = "/repo/paseo") {
  return {
    ...normalizeAgentSnapshot(
      {
        id,
        provider: "codex",
        cwd,
        workspaceId,
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
        title: `Agent ${id}`,
        labels: {},
      },
      SERVER_ID,
    ),
    projectPlacement: {
      projectKey: cwd,
      projectName: cwd.split("/").at(-1) ?? cwd,
      workspaceName: workspaceId,
      checkout: {
        cwd,
        isGit: false as const,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false as const,
        mainRepoRoot: null,
      },
    },
  };
}

function message(id: string, text: string): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date("2026-07-18T08:02:00.000Z"),
    timelineCursor: { epoch: "epoch-1", seq: 12 },
  };
}

function toolCall(): StreamItem {
  return {
    kind: "tool_call",
    id: "tool-1",
    timelineCursor: { epoch: "epoch-1", seq: 12 },
    timestamp: new Date("2026-07-18T08:02:00.000Z"),
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: "call-1",
        name: "shell",
        status: "completed",
        error: null,
        detail: {
          type: "shell",
          command: "npm test",
          output: "passed",
          exitCode: 0,
        },
      },
    },
  };
}

function seedSession(): void {
  const store = useSessionStore.getState();
  store.initializeSession(SERVER_ID, null);
  store.setAgents(
    SERVER_ID,
    new Map([
      [
        "agent-1",
        {
          ...agent("agent-1"),
          pendingPermissions: [
            {
              id: "pending-permission",
              provider: "codex",
              name: "shell",
              kind: "tool",
              title: "Approve shell command",
            },
          ],
        },
      ],
    ]),
  );
  store.setWorkspaces(
    SERVER_ID,
    new Map([
      [
        "workspace-1",
        normalizeWorkspaceDescriptor({
          ...workspace(),
          workspaceKind: "worktree",
          worktreeSlug: "owned-worktree",
          labels: ["backend"],
        }),
      ],
    ]),
  );
  store.setProjects(SERVER_ID, [
    normalizeProjectDescriptor({
      projectId: "project-1",
      projectKey: "remote:github.com/getpaseo/paseo",
      projectDisplayName: "Paseo",
      projectRootPath: "/repo/paseo",
      projectKind: "git",
    }),
    normalizeProjectDescriptor({
      projectId: "empty-project",
      projectDisplayName: "Empty project",
      projectRootPath: "/repo/empty",
      projectKind: "directory",
    }),
  ]);
  store.setFocusedAgentId(SERVER_ID, "agent-1");
  store.setAgentStreamTail(SERVER_ID, new Map([["agent-1", [message("message-1", "Cached")]]]));
  store.setAgentTimelineCursor(
    SERVER_ID,
    new Map([["agent-1", { epoch: "epoch-1", startSeq: 1, endSeq: 12 }]]),
  );
  store.setAgentTimelineHasOlder(SERVER_ID, new Map([["agent-1", true]]));
  store.setAgentAuthoritativeHistoryApplied(SERVER_ID, "agent-1", true);
}

function seedTimeline(serverId: string, text: string): void {
  const agentId = `agent-${serverId}`;
  const workspaceId = `workspace-${serverId}`;
  const workspaceDirectory = `/repo/${serverId}`;
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null);
  store.setAgents(serverId, new Map([[agentId, agent(agentId, workspaceId, workspaceDirectory)]]));
  store.setWorkspaces(
    serverId,
    new Map([
      [
        workspaceId,
        normalizeWorkspaceDescriptor(
          workspace(workspaceId, `project-${serverId}`, workspaceDirectory),
        ),
      ],
    ]),
  );
  store.setFocusedAgentId(serverId, agentId);
  store.setAgentStreamTail(serverId, new Map([[agentId, [message(`message-${serverId}`, text)]]]));
}

afterEach(() => {
  vi.useRealTimers();
  const store = useSessionStore.getState();
  store.clearSession(SERVER_ID);
  for (const serverId of LRU_SERVER_IDS) store.clearSession(serverId);
});

describe("ReplicaCache", () => {
  it("persists after user inactivity even while replica changes continue", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const replicaCache = cache(storage);
    replicaCache.setHosts([SERVER_ID]);
    seedSession();
    await replicaCache.flush();
    replicaCache.start();
    const writesBeforeChange = storage.writes;

    useSessionStore
      .getState()
      .setAgentStreamTail(SERVER_ID, new Map([["agent-1", [message("first", "First")]]]));
    await vi.advanceTimersByTimeAsync(4_000);
    replicaCache.recordUserActivity();
    await vi.advanceTimersByTimeAsync(1_000);
    useSessionStore
      .getState()
      .setAgentStreamTail(SERVER_ID, new Map([["agent-1", [message("second", "Second")]]]));
    await vi.advanceTimersByTimeAsync(3_999);

    expect(storage.writes).toBe(writesBeforeChange);

    await vi.advanceTimersByTimeAsync(1);

    expect(storage.writes).toBe(writesBeforeChange + 1);
    replicaCache.setHosts([]);
  });

  it("persists focused replica changes without writing transient stream head updates", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const replicaCache = cache(storage);
    replicaCache.setHosts([SERVER_ID]);
    seedSession();
    await replicaCache.flush();
    replicaCache.start();
    const writesBeforeStream = storage.writes;

    useSessionStore
      .getState()
      .setAgentStreamHead(SERVER_ID, new Map([["agent-1", [message("live", "Streaming")]]]));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(storage.writes).toBe(writesBeforeStream);

    useSessionStore
      .getState()
      .setAgentStreamTail(SERVER_ID, new Map([["agent-1", [message("saved", "Committed")]]]));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(storage.writes).toBe(writesBeforeStream + 1);
    replicaCache.setHosts([]);
  });

  it("restores the exact persisted canonical timeline window", async () => {
    const storage = new MemoryStorage();
    const writer = cache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    await writer.flush();

    useSessionStore.getState().clearSession(SERVER_ID);

    const reader = cache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(session).toBeDefined();
    if (!session) throw new Error("Expected restored session");
    expect(session.client).toBeNull();
    expect(session.hasHydratedAgents).toBe(false);
    expect(session.hasHydratedWorkspaces).toBe(false);
    expect(session.hasWorkspaceDirectorySnapshot).toBe(true);
    expect(Array.from(session.agents.keys())).toEqual(["agent-1"]);
    expect(Array.from(session.workspaces.keys())).toEqual(["workspace-1"]);
    expect(Array.from(session.projects.keys())).toEqual(["project-1", "empty-project"]);
    expect(session.agents.get("agent-1")?.updatedAt).toBeInstanceOf(Date);
    expect(session.agents.get("agent-1")?.projectPlacement?.checkout.cwd).toBe("/repo/paseo");
    expect(session.agents.get("agent-1")?.pendingPermissions).toEqual([]);
    expect(session.workspaces.get("workspace-1")?.statusEnteredAt).toBeInstanceOf(Date);
    expect(session.workspaces.get("workspace-1")?.worktreeSlug).toBe("owned-worktree");
    // A restored row draws its label chips. The reconnect cursor is current, so nothing re-sends
    // them and a cache that dropped them would leave the sidebar unlabelled until the next edit.
    expect(session.workspaces.get("workspace-1")?.labels).toEqual(["backend"]);
    expect(session.agentStreamTail.get("agent-1")).toEqual([message("message-1", "Cached")]);
    expect(session.agentAuthoritativeHistoryApplied).toEqual(new Map([["agent-1", true]]));
    expect(session.agentTimelineCursor).toEqual(
      new Map([["agent-1", { epoch: "epoch-1", startSeq: 1, endSeq: 12 }]]),
    );
    expect(session.agentTimelineHasOlder).toEqual(new Map([["agent-1", true]]));
    expect(session.agentTimelineHasNewer).toEqual(new Map([["agent-1", false]]));
    expect(session.agentHistorySyncGeneration).toEqual(new Map());
    expect(selectAgentTimelineState(session, "agent-1")).toEqual({
      status: "synced",
      items: [message("message-1", "Cached")],
      range: { epoch: "epoch-1", startSeq: 1, endSeq: 12 },
      older: "available",
      newer: "none",
    });
  });

  it("restores canonical turn membership without downgrading tagged rows", async () => {
    const storage = new MemoryStorage();
    const writer = cache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    const initial: StreamItem = {
      kind: "user_message",
      id: "initial",
      text: "initial",
      timestamp: new Date(1),
      turnId: "turn-1",
    };
    const hello: StreamItem = {
      kind: "user_message",
      id: "hello",
      text: "hello",
      timestamp: new Date(2),
      turnId: "turn-1",
      clientMessageId: "hello-client",
      messageId: "hello-client",
    };
    useSessionStore
      .getState()
      .setAgentStreamTail(
        SERVER_ID,
        new Map([["agent-1", [initial, message("assistant", "done"), hello]]]),
      );
    await writer.flush();
    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = cache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();
    const tail =
      useSessionStore.getState().sessions[SERVER_ID]?.agentStreamTail.get("agent-1") ?? [];
    expect(tail.find((item) => item.id === "hello")?.turnId).toBe("turn-1");
  });

  it("restores tool calls inside an authoritative cached window", async () => {
    const storage = new MemoryStorage();
    const writer = cache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    useSessionStore.getState().setAgentStreamTail(SERVER_ID, new Map([["agent-1", [toolCall()]]]));
    await writer.flush();

    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = cache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(session?.agentStreamTail.get("agent-1")).toEqual([toolCall()]);
    expect(session?.agentTimelineCursor.get("agent-1")).toEqual({
      epoch: "epoch-1",
      startSeq: 1,
      endSeq: 12,
    });
  });

  it("restores display-only when retained items do not reach the stored range end", async () => {
    const storage = new MemoryStorage();
    const writer = cache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    useSessionStore
      .getState()
      .setAgentTimelineCursor(
        SERVER_ID,
        new Map([["agent-1", { epoch: "epoch-1", startSeq: 1, endSeq: 13 }]]),
      );
    await writer.flush();

    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = cache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(session?.agentStreamTail.get("agent-1")).toEqual([message("message-1", "Cached")]);
    expect(session?.agentTimelineCursor).toEqual(new Map());
    expect(selectAgentTimelineState(session, "agent-1")).toEqual({
      status: "painted",
      items: [message("message-1", "Cached")],
    });
  });

  it("persists the complete directory with only the focused timeline tail", async () => {
    const storage = new MemoryStorage();
    const replicaCache = cache(storage);
    replicaCache.setHosts([SERVER_ID]);
    seedSession();

    const store = useSessionStore.getState();
    store.setAgents(SERVER_ID, (agents) =>
      new Map(agents).set("agent-2", agent("agent-2", "workspace-2", "/repo/other")),
    );
    store.setWorkspaces(SERVER_ID, (workspaces) =>
      new Map(workspaces).set(
        "workspace-2",
        normalizeWorkspaceDescriptor(workspace("workspace-2", "project-2", "/repo/other")),
      ),
    );
    const secondTimeline = Array.from({ length: 60 }, (_, index) => ({
      ...message(`message-${index}`, `Second ${index}`),
      timelineCursor: { epoch: "epoch-2", seq: index + 1 },
    }));
    store.setAgentStreamTail(
      SERVER_ID,
      new Map([
        ["agent-1", [message("message-1", "First")]],
        ["agent-2", secondTimeline],
      ]),
    );
    store.setAgentTimelineCursor(
      SERVER_ID,
      new Map([["agent-2", { epoch: "epoch-2", startSeq: 1, endSeq: 60 }]]),
    );
    store.setAgentTimelineHasOlder(SERVER_ID, new Map([["agent-2", true]]));
    store.setAgentAuthoritativeHistoryApplied(SERVER_ID, "agent-2", true);
    store.setFocusedAgentId(SERVER_ID, "agent-2");
    await replicaCache.flush();

    store.clearSession(SERVER_ID);
    const reader = cache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    const session = useSessionStore.getState().sessions[SERVER_ID];
    const timelines = session?.agentStreamTail;
    expect(Array.from(session?.agents.keys() ?? [])).toEqual(["agent-1", "agent-2"]);
    expect(Array.from(session?.workspaces.keys() ?? [])).toEqual(["workspace-1", "workspace-2"]);
    expect(Array.from(session?.projects.keys() ?? [])).toEqual([
      "project-1",
      "project-2",
      "empty-project",
    ]);
    expect(Array.from(timelines?.keys() ?? [])).toEqual(["agent-2"]);
    expect(timelines?.get("agent-2")).toEqual(secondTimeline.slice(-50));
    expect(session?.agentTimelineCursor.has("agent-2")).toBe(false);
    expect(selectAgentTimelineState(session, "agent-2")).toEqual({
      status: "painted",
      items: secondTimeline.slice(-50),
    });

    const timelineRow = [...storage.rows.values()].find((row) => row.kind === "timeline");
    expect(timelineRow).toBeDefined();
    if (!timelineRow) throw new Error("Expected persisted timeline row");
    const persisted = JSON.parse(timelineRow.payload) as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual(["agentId", "hasOlder", "items", "range"]);
  });

  it("persists reconciled rows without caching unreconciled local presentations", async () => {
    const storage = new MemoryStorage();
    const replicaCache = cache(storage);
    replicaCache.setHosts([SERVER_ID]);
    seedSession();
    const unreconciled = createUserMessage({
      clientMessageId: "client-pending",
      text: "Pending",
      timestamp: new Date("2026-07-18T08:01:00.000Z"),
    });
    const reconciled = createUserMessage({
      clientMessageId: "client-sent",
      messageId: "provider-sent",
      timelineCursor: { epoch: "epoch-1", seq: 11 },
      text: "Sent",
      timestamp: new Date("2026-07-18T08:01:30.000Z"),
    });
    useSessionStore
      .getState()
      .setAgentStreamTail(SERVER_ID, new Map([["agent-1", [unreconciled, reconciled]]]));

    await replicaCache.flush();
    useSessionStore.getState().clearSession(SERVER_ID);
    await replicaCache.restore();

    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentStreamTail.get("agent-1")).toEqual([
      reconciled,
    ]);
  });

  it("persists monotonic directory cursors with the complete host replica", async () => {
    const storage = new MemoryStorage();
    const replicaCache = cache(storage);
    replicaCache.setHosts([SERVER_ID]);
    seedSession();
    await replicaCache.flush();

    replicaCache.writeDirectoryCheckpoint(SERVER_ID, {
      agents: { generation: "daemon-generation", afterSeq: 7 },
    });
    useSessionStore.getState().setAgents(SERVER_ID, (agents) => {
      const current = agents.get("agent-1");
      if (!current) throw new Error("Expected seeded agent");
      return new Map(agents).set("agent-1", { ...current, title: "Updated agent" });
    });
    await replicaCache.flush();

    const reader = cache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();
    expect(reader.readDirectoryCheckpoint(SERVER_ID)).toEqual({
      agents: { generation: "daemon-generation", afterSeq: 7 },
    });
    const finalWrite = storage.changes.at(-1);
    expect(finalWrite?.upserts.map((row) => row.kind).sort()).toEqual(["agent", "checkpoint"]);
  });

  it("persists one agent update as exactly one row upsert", async () => {
    const storage = new MemoryStorage();
    const replicaCache = cache(storage);
    replicaCache.setHosts([SERVER_ID]);
    seedSession();
    await replicaCache.flush();
    storage.changes.length = 0;

    useSessionStore.getState().setAgents(SERVER_ID, (agents) => {
      const current = agents.get("agent-1");
      if (!current) throw new Error("Expected seeded agent");
      return new Map(agents).set(current.id, { ...current, title: "Updated" });
    });
    await replicaCache.flush();

    expect(storage.changes).toHaveLength(1);
    expect(storage.changes[0]).toMatchObject({
      upserts: [{ serverId: SERVER_ID, kind: "agent", id: "agent-1" }],
      deletes: [],
    });
  });

  it("persists a checkpoint without serializing host entity rows", async () => {
    const storage = new MemoryStorage();
    const replicaCache = cache(storage);
    replicaCache.setHosts([SERVER_ID]);
    seedSession();
    await replicaCache.flush();
    storage.changes.length = 0;

    replicaCache.writeDirectoryCheckpoint(SERVER_ID, {
      agents: { generation: "generation", afterSeq: 4 },
    });
    await replicaCache.flush();

    expect(storage.changes).toHaveLength(1);
    expect(storage.changes[0]?.upserts).toEqual([
      expect.objectContaining({ kind: "checkpoint", id: "singleton" }),
    ]);
  });

  it("maps host removal and reconciliation to row-store host operations", async () => {
    const storage = new MemoryStorage();
    const replicaCache = cache(storage);
    replicaCache.setHosts([SERVER_ID]);
    seedSession();
    await replicaCache.flush();

    replicaCache.reconcileServerId(SERVER_ID, "reconciled-host");
    await replicaCache.flush();
    replicaCache.setHosts([]);
    await replicaCache.flush();

    expect(storage.renamedHosts).toEqual([
      { oldServerId: SERVER_ID, newServerId: "reconciled-host" },
    ]);
    expect(storage.deletedHosts).toContain("reconciled-host");
  });

  it("restores workspace change request checks beside the directory cursor", async () => {
    const githubRuntime = {
      featuresEnabled: true,
      pullRequest: {
        number: 824,
        url: "https://github.com/blank-dot-page/editor/pull/824",
        title: "Cut realistic editor typing latency by two thirds",
        state: "OPEN",
        baseRefName: "main",
        headRefName: "perf-editor-typing-latency",
        isMerged: false,
        checksStatus: "success" as const,
        checks: [
          {
            name: "Check",
            status: "success" as const,
            url: "https://github.com/blank-dot-page/editor/actions/runs/824",
          },
        ],
      },
      error: null,
    };
    const storage = new MemoryStorage();
    const writer = cache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    useSessionStore.getState().setWorkspaces(
      SERVER_ID,
      new Map([
        [
          "workspace-1",
          normalizeWorkspaceDescriptor({
            ...workspace(),
            forge: "github",
            githubRuntime,
          }),
        ],
      ]),
    );
    writer.writeDirectoryCheckpoint(SERVER_ID, {
      workspaces: { generation: "daemon-generation", afterSeq: 9 },
    });
    await writer.flush();

    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = cache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    expect(
      useSessionStore.getState().sessions[SERVER_ID]?.workspaces.get("workspace-1")?.githubRuntime,
    ).toEqual(githubRuntime);
    expect(reader.readDirectoryCheckpoint(SERVER_ID)).toEqual({
      workspaces: { generation: "daemon-generation", afterSeq: 9 },
    });
  });

  it("restores every registered host directory before any host reconnects", async () => {
    const storage = new MemoryStorage();
    const writer = cache(storage);
    writer.setHosts(LRU_SERVER_IDS);
    for (const serverId of LRU_SERVER_IDS) seedTimeline(serverId, `cached-${serverId}`);
    await writer.flush();
    for (const serverId of LRU_SERVER_IDS) useSessionStore.getState().clearSession(serverId);

    const reader = cache(storage);
    reader.setHosts(LRU_SERVER_IDS);
    await reader.restore();

    for (const serverId of LRU_SERVER_IDS) {
      const session = useSessionStore.getState().sessions[serverId];
      expect(Array.from(session?.agents.keys() ?? [])).toEqual([`agent-${serverId}`]);
      expect(Array.from(session?.workspaces.keys() ?? [])).toEqual([`workspace-${serverId}`]);
      expect(session?.hasHydratedAgents).toBe(false);
      expect(session?.hasHydratedWorkspaces).toBe(false);
      expect(session?.hasWorkspaceDirectorySnapshot).toBe(true);
    }
  });

  it("evicts the least recently written host when the cache exceeds its byte budget", async () => {
    const storage = new MemoryStorage();
    const replicaCache = cache(storage, { maxBytes: 7_000 });
    replicaCache.setHosts(LRU_SERVER_IDS.slice(0, 2));
    seedTimeline("host-a", "A".repeat(1_200));
    seedTimeline("host-b", "B".repeat(1_200));
    await replicaCache.flush();

    seedTimeline("host-a", "A".repeat(1_201));
    await replicaCache.flush();

    replicaCache.setHosts(LRU_SERVER_IDS);
    seedTimeline("host-c", "C".repeat(1_200));
    await replicaCache.flush();

    for (const serverId of LRU_SERVER_IDS) {
      useSessionStore.getState().clearSession(serverId);
    }
    const reader = cache(storage, { maxBytes: 7_000 });
    reader.setHosts(LRU_SERVER_IDS);
    await reader.restore();

    expect(Object.keys(useSessionStore.getState().sessions).sort()).toEqual(["host-a", "host-c"]);
  });

  it("clears the whole cache when one row payload is corrupt", async () => {
    const storage = new MemoryStorage();
    storage.rows.set(`${SERVER_ID}:agent:agent-1`, {
      serverId: SERVER_ID,
      kind: "agent",
      id: "agent-1",
      payload: "{not json",
    });
    storage.rows.set(`${SERVER_ID}:project:project-1`, {
      serverId: SERVER_ID,
      kind: "project",
      id: "project-1",
      payload: JSON.stringify({ projectId: "project-1" }),
    });
    const replicaCache = cache(storage);
    replicaCache.setHosts([SERVER_ID]);

    await replicaCache.restore();

    expect(useSessionStore.getState().sessions[SERVER_ID]).toBeUndefined();
    expect(storage.rows.size).toBe(0);
    expect(storage.clears).toBe(1);
  });

  it("clears the whole cache when a valid JSON row has an unknown shape", async () => {
    const storage = new MemoryStorage();
    storage.rows.set(`${SERVER_ID}:project:project-1`, {
      serverId: SERVER_ID,
      kind: "project",
      id: "project-1",
      payload: JSON.stringify({ projectId: "project-1", surprise: true }),
    });
    const replicaCache = cache(storage);
    replicaCache.setHosts([SERVER_ID]);

    await replicaCache.restore();

    expect(storage.rows.size).toBe(0);
    expect(storage.clears).toBe(1);
  });

  it("runs legacy blob cleanup when the row store is first prepared", async () => {
    const storage = new MemoryStorage();
    let cleanups = 0;
    const replicaCache = new ReplicaCache(storage, {
      clearLegacyCache: async () => {
        cleanups += 1;
      },
    });
    replicaCache.setHosts([SERVER_ID]);

    await replicaCache.restore();
    await replicaCache.flush();

    expect(cleanups).toBe(1);
  });
});
