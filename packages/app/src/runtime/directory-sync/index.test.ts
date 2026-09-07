import { afterEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
} from "@/stores/session-store";
import { normalizeAgentSnapshot, projectAgentSnapshot } from "@/utils/agent-snapshots";
import { selectWorkspaceDirectoryServerIds } from "@/stores/session-store-hooks/selectors";
import { ReplicaCache, type DirectoryReplicaMutation } from "@/runtime/replica-cache";
import { createTimelineReplica } from "@/timeline/replica";
import { createViewedTimelineOwner } from "@/timeline/viewed-timeline-sync";
import type {
  ReplicaHostRows,
  ReplicaRow,
  ReplicaRowChanges,
  ReplicaRowStore,
} from "@/runtime/replica-cache/row-store";
import {
  DirectoryRefreshSupersededError,
  DirectorySync,
  type DirectoryCheckpointStorage,
} from "./index";

type WorkspaceFetchResult = Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>;
type ProjectListResult = Awaited<ReturnType<DaemonClient["listProjects"]>>;
type AgentFetchResult = Awaited<ReturnType<DaemonClient["fetchAgents"]>>;
type TimelineFetchResult = Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>;

class FakeDirectoryClient {
  fetchAgentsCalls = 0;
  lastAgentOptions: unknown;
  fetchWorkspacesCalls = 0;
  lastWorkspaceOptions: unknown;
  listProjectsCalls = 0;
  lastProjectOptions: unknown;
  projectResult: ProjectListResult | null = null;
  private pendingAgentFetch: Promise<AgentFetchResult> | null = null;
  private pendingWorkspaceFetch: Promise<WorkspaceFetchResult> | null = null;
  private readonly pendingTimelineFetches: Array<{
    promise: Promise<TimelineFetchResult>;
    resolve(result: TimelineFetchResult): void;
  }> = [];
  private readonly handlers = new Map<
    SessionOutboundMessage["type"],
    Set<(message: SessionOutboundMessage) => void>
  >();

  on<TType extends SessionOutboundMessage["type"]>(
    type: TType,
    handler: (message: Extract<SessionOutboundMessage, { type: TType }>) => void,
  ): () => void {
    const handlers = this.handlers.get(type) ?? new Set();
    const registered = handler as unknown as (message: SessionOutboundMessage) => void;
    handlers.add(registered);
    this.handlers.set(type, handlers);
    return () => handlers.delete(registered);
  }

  emit<TType extends SessionOutboundMessage["type"]>(
    message: Extract<SessionOutboundMessage, { type: TType }>,
  ): void {
    for (const handler of this.handlers.get(message.type) ?? []) handler(message);
  }

  holdWorkspaceFetch(): (result: WorkspaceFetchResult) => void {
    let complete!: (result: WorkspaceFetchResult) => void;
    this.pendingWorkspaceFetch = new Promise((resolve) => {
      complete = resolve;
    });
    return complete;
  }

  holdAgentFetch(): (result: AgentFetchResult) => void {
    let complete!: (result: AgentFetchResult) => void;
    this.pendingAgentFetch = new Promise((resolve) => {
      complete = resolve;
    });
    return complete;
  }

  async fetchAgents(options?: unknown): Promise<Awaited<ReturnType<DaemonClient["fetchAgents"]>>> {
    this.fetchAgentsCalls += 1;
    this.lastAgentOptions = options;
    if (this.pendingAgentFetch) {
      const pending = this.pendingAgentFetch;
      this.pendingAgentFetch = null;
      return pending;
    }
    return {
      requestId: "agents",
      entries: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    };
  }

  async fetchWorkspaces(options?: unknown): Promise<WorkspaceFetchResult> {
    this.fetchWorkspacesCalls += 1;
    this.lastWorkspaceOptions = options;
    if (this.pendingWorkspaceFetch) {
      const pending = this.pendingWorkspaceFetch;
      this.pendingWorkspaceFetch = null;
      return pending;
    }
    return {
      requestId: "workspaces",
      entries: [],
      emptyProjects: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    };
  }

  fetchAgentTimeline(): Promise<TimelineFetchResult> {
    let resolve!: (result: TimelineFetchResult) => void;
    const promise = new Promise<TimelineFetchResult>((complete) => {
      resolve = complete;
    });
    this.pendingTimelineFetches.push({ promise, resolve });
    return promise;
  }

  nextTimelineFetch(): { resolve(result: TimelineFetchResult): void } {
    const pending = this.pendingTimelineFetches.shift();
    if (!pending) throw new Error("Expected a pending timeline fetch");
    return { resolve: pending.resolve };
  }

  async listProjects(options?: unknown): Promise<ProjectListResult> {
    this.listProjectsCalls += 1;
    this.lastProjectOptions = options;
    if (this.projectResult) return this.projectResult;
    return {
      requestId: "projects",
      projects: [
        {
          projectId: "project-1",
          projectKey: "remote:github.com/acme/app",
          projectDisplayName: "acme/app",
          projectRootPath: "/repo/app",
          projectKind: "git",
        },
      ],
    };
  }

  getLastServerInfoMessage(): null {
    return null;
  }
}

class MemoryRowStore implements ReplicaRowStore {
  readonly rows = new Map<string, ReplicaRow>();
  readAllGate: Promise<void> | null = null;

  private key(row: Pick<ReplicaRow, "serverId" | "kind" | "id">): string {
    return `${row.serverId}:${row.kind}:${row.id}`;
  }

  async open(): Promise<void> {}

  async read(
    serverIds: readonly string[],
    kinds: readonly ReplicaRow["kind"][],
    ids?: readonly string[],
  ): Promise<ReplicaRow[]> {
    await this.readAllGate;
    return [...this.rows.values()].filter(
      (row) =>
        serverIds.includes(row.serverId) &&
        kinds.includes(row.kind) &&
        (!ids || ids.includes(row.id)),
    );
  }

  async readAll(): Promise<ReplicaHostRows[]> {
    await this.readAllGate;
    const hosts = new Map<string, ReplicaRow[]>();
    for (const row of this.rows.values()) {
      hosts.set(row.serverId, [...(hosts.get(row.serverId) ?? []), row]);
    }
    return [...hosts].map(([serverId, rows]) => ({ serverId, rows }));
  }

  async apply(changes: ReplicaRowChanges): Promise<void> {
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

// A saved directory on disk, read back through the real storage owner with its load gated.
async function savedDirectory(
  serverId: string,
  directory: Parameters<ReplicaCache["replaceDirectoryBaseline"]>[1],
): Promise<{ cache: ReplicaCache; releaseLoad: () => void }> {
  const rowStore = new MemoryRowStore();
  const writer = new ReplicaCache(rowStore, { clearLegacyCache: async () => undefined });
  writer.setHosts([serverId]);
  writer.replaceDirectoryBaseline(serverId, directory);
  await writer.flush();
  let releaseLoad!: () => void;
  rowStore.readAllGate = new Promise((resolve) => {
    releaseLoad = resolve;
  });
  const cache = new ReplicaCache(rowStore, { clearLegacyCache: async () => undefined });
  cache.setHosts([serverId]);
  return { cache, releaseLoad };
}

const noopCallbacks = {
  onTimelineRequest: () => () => undefined,
  onAgentStoppedRunning: () => undefined,
  onAgentRemoved: () => undefined,
  markAgentLoading: () => undefined,
  markAgentReady: () => undefined,
  markAgentError: () => undefined,
};

const serverIds = new Set<string>();

function createDirectory(
  serverId: string,
  callbacks: ConstructorParameters<typeof DirectorySync>[1] = noopCallbacks,
): {
  client: FakeDirectoryClient;
  directory: DirectorySync;
} {
  serverIds.add(serverId);
  const client = new FakeDirectoryClient();
  const directory = new DirectorySync(serverId, callbacks);
  directory.connectionChanged({
    client: client as unknown as DaemonClient,
    status: "online",
    source: { clientGeneration: 1, connectionEpoch: 1 },
  });
  return { client, directory };
}

function createAgent(serverId: string, id: string) {
  return {
    ...normalizeAgentSnapshot(
      {
        id,
        provider: "codex",
        cwd: "/repo",
        model: null,
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
        lastUserMessageAt: null,
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
        title: "Cached",
        labels: {},
      },
      serverId,
    ),
    projectPlacement: null,
  };
}

it.each(["snapshot", "changes", "live"] as const)(
  "%s scope exclusion retains the saved page but invalidates old work; deletion removes it",
  async (exclusion) => {
    const serverId = `timeline-scope-${exclusion}`;
    serverIds.add(serverId);
    useSessionStore.getState().initializeSession(serverId, null);
    const rows = new MemoryRowStore();
    const cache = new ReplicaCache(rows, { clearLegacyCache: async () => undefined });
    cache.setHosts([serverId]);
    const saved = {
      agentId: "agent",
      range: { epoch: "epoch", startSeq: 1, endSeq: 1 },
      hasOlder: false,
      items: [
        {
          kind: "assistant_message" as const,
          id: "saved",
          text: "saved history",
          timestamp: new Date("2026-09-06T00:00:00Z"),
          timelineCursor: { epoch: "epoch", seq: 1 },
          source: { startSeq: 1 },
        },
      ],
    };
    cache.commitTimeline(serverId, "agent", saved);
    await cache.flush();
    const replica = createTimelineReplica({ serverId, storage: cache });
    const viewed = createViewedTimelineOwner({
      serverId,
      replica,
      replaceDemandedAgentIds: () => undefined,
      drainQueuedAgentMessage: () => undefined,
    });
    const directory = new DirectorySync(
      serverId,
      {
        ...noopCallbacks,
        onAgentRemoved: (...args) => viewed.removeAgent(...args),
        onAgentAccepted: (id) => viewed.acceptAgent(id),
      },
      cache,
    );
    const client = new FakeDirectoryClient();
    useSessionStore.getState().updateSessionClient(serverId, client as unknown as DaemonClient, 1);
    useSessionStore.getState().updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true, directorySync: true },
    });
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });
    directory.acceptAgent(createAgent(serverId, "agent"));
    await replica.prepare("agent");
    const stale = directory.fetchTimeline("agent", {
      direction: "tail",
      limit: 40,
      projection: "projected",
    });
    const staleReply = client.nextTimelineFetch();
    if (exclusion === "live") {
      client.emit({ type: "agent_update", payload: { kind: "remove", agentId: "agent" } });
    } else {
      const reply = client.holdAgentFetch();
      const refreshing = directory.refreshAgents();
      await expect.poll(() => client.fetchAgentsCalls).toBe(1);
      reply({
        requestId: "scope",
        entries: [],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        ...(exclusion === "changes"
          ? {
              sync: {
                generation: "g",
                headSeq: 1,
                mode: "changes" as const,
                removals: [{ id: "agent", seq: 1 }],
              },
            }
          : {}),
      });
      await refreshing;
    }
    expect(useSessionStore.getState().sessions[serverId]?.agentStreamTail.has("agent")).toBe(false);
    expect(useSessionStore.getState().sessions[serverId]?.agents.has("agent")).toBe(false);
    viewed.enqueueStreamEvent("agent", {
      epoch: "epoch",
      seq: 2,
      timestamp: new Date("2026-09-06T00:00:01Z"),
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "late work", messageId: "late" },
      },
    });
    viewed.flushStreamAgent("agent");
    expect(useSessionStore.getState().sessions[serverId]?.agentStreamTail.has("agent")).toBe(false);
    await cache.flush();
    const reopened = new ReplicaCache(rows, { clearLegacyCache: async () => undefined });
    reopened.setHosts([serverId]);
    expect(await reopened.readTimeline(serverId, "agent")).toEqual(saved);
    directory.acceptAgent(createAgent(serverId, "agent"));
    await replica.prepare("agent");
    staleReply.resolve({ agent: null, hasNewer: false } as TimelineFetchResult);
    await expect(stale).rejects.toBeInstanceOf(DirectoryRefreshSupersededError);
    expect(useSessionStore.getState().sessions[serverId]?.agentStreamTail.get("agent")).toEqual(
      saved.items,
    );
    // Deletion must also remove a saved page whose agent is already out of scope.
    client.emit({ type: "agent_update", payload: { kind: "remove", agentId: "agent" } });
    client.emit({ type: "agent_deleted", payload: { agentId: "agent", requestId: "delete" } });
    // The subsequent directory remove must not recreate the deleted row.
    client.emit({ type: "agent_update", payload: { kind: "remove", agentId: "agent" } });
    await cache.flush();
    const afterDeletion = new ReplicaCache(rows, { clearLegacyCache: async () => undefined });
    afterDeletion.setHosts([serverId]);
    expect(await afterDeletion.readTimeline(serverId, "agent")).toBeUndefined();
    viewed.dispose();
    directory.dispose();
  },
);

it.each(["snapshot-first", "page-first", "live-first"] as const)(
  "first admission preserves the first timeline page (%s)",
  async (ordering) => {
    const serverId = `first-admission-${ordering}`;
    serverIds.add(serverId);
    useSessionStore.getState().initializeSession(serverId, null);
    const rows = new MemoryRowStore();
    const cache = new ReplicaCache(rows, { clearLegacyCache: async () => undefined });
    cache.setHosts([serverId]);
    const replica = createTimelineReplica({ serverId, storage: cache });
    const viewed = createViewedTimelineOwner({
      serverId,
      replica,
      replaceDemandedAgentIds: () => undefined,
      drainQueuedAgentMessage: () => undefined,
    });
    let applications = 0;
    const { directory, client } = createDirectory(serverId, {
      ...noopCallbacks,
      onAgentAccepted: (id) => viewed.acceptAgent(id),
      onTimelineRequest: (id) => {
        const apply = viewed.beginTimelineRequest(id);
        return (page) => {
          applications++;
          apply(page);
        };
      },
    });
    useSessionStore.getState().updateSessionClient(serverId, client as unknown as DaemonClient, 1);
    useSessionStore.getState().updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true },
    });
    await directory.ready();
    const request = { direction: "tail" as const, limit: 40, projection: "projected" as const };
    const fetching = directory.fetchTimeline("agent", request);
    const concurrent = directory.fetchTimeline("agent", request);
    const reply = client.nextTimelineFetch();
    const agent = projectAgentSnapshot(createAgent(serverId, "agent"));
    const page: TimelineFetchResult = {
      requestId: "first",
      agentId: "agent",
      agent,
      direction: "tail",
      projection: "projected",
      reset: false,
      staleCursor: false,
      gap: false,
      epoch: "epoch",
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
      startCursor: { epoch: "epoch", seq: 1 },
      endCursor: { epoch: "epoch", seq: 1 },
      hasOlder: false,
      hasNewer: false,
      error: null,
      entries: [
        {
          provider: "codex",
          item: { type: "assistant_message", text: "first page", messageId: "first" },
          timestamp: "2026-09-06T00:00:00Z",
          seqStart: 1,
          seqEnd: 1,
          sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
          collapsed: [],
        },
      ],
    };
    if (ordering === "page-first") {
      reply.resolve(page);
      await fetching;
    }
    if (ordering === "live-first")
      client.emit({ type: "agent_update", payload: { kind: "upsert", agent } });
    else {
      const release = client.holdAgentFetch();
      const refreshing = directory.refreshAgents();
      await expect.poll(() => client.fetchAgentsCalls).toBe(1);
      release({
        requestId: "directory",
        entries: [
          {
            agent,
            project: {
              projectKey: "/repo",
              projectName: "repo",
              checkout: {
                cwd: "/repo",
                isGit: false,
                currentBranch: null,
                remoteUrl: null,
                worktreeRoot: null,
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              },
            },
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      });
      await refreshing;
    }
    if (ordering !== "page-first") reply.resolve(page);
    await expect(Promise.all([fetching, concurrent])).resolves.toEqual([page, page]);
    expect(applications).toBe(1);
    expect(() => client.nextTimelineFetch()).toThrow("Expected a pending timeline fetch");
    expect(
      useSessionStore.getState().sessions[serverId]?.agentStreamTail.get("agent")?.[0],
    ).toMatchObject({ text: "first page" });
    viewed.dispose();
    directory.dispose();
  },
);

it("rejects an old timeline reply after authoritative agent re-entry", async () => {
  const serverId = "timeline-lifetime";
  serverIds.add(serverId);
  useSessionStore.getState().initializeSession(serverId, null);
  const client = new FakeDirectoryClient();
  const lifetimes: string[] = [];
  const directory = new DirectorySync(serverId, {
    onTimelineRequest: () => () => undefined,
    onAgentStoppedRunning: () => undefined,
    onAgentRemoved: (agentId) => lifetimes.push(`remove:${agentId}`),
    onAgentAccepted: (agentId) => lifetimes.push(`accept:${agentId}`),
    markAgentLoading: () => undefined,
    markAgentReady: () => undefined,
    markAgentError: () => undefined,
  });
  directory.connectionChanged({
    client: client as unknown as DaemonClient,
    status: "online",
    source: { clientGeneration: 1, connectionEpoch: 1 },
  });
  directory.acceptAgent(createAgent(serverId, "agent"));
  const request = { direction: "tail" as const, limit: 40, projection: "projected" as const };
  const oldFetch = directory.fetchTimeline("agent", request);
  const oldReply = client.nextTimelineFetch();

  directory.removeAgent("agent");
  const excludedFetch = directory.fetchTimeline("agent", request);
  const excludedReply = client.nextTimelineFetch();
  directory.acceptAgent(createAgent(serverId, "agent"));
  const freshFetch = directory.fetchTimeline("agent", request);
  const freshReply = client.nextTimelineFetch();
  const page = { agent: null, hasNewer: false } as TimelineFetchResult;

  oldReply.resolve(page);
  await expect(oldFetch).rejects.toBeInstanceOf(DirectoryRefreshSupersededError);
  excludedReply.resolve(page);
  await expect(excludedFetch).rejects.toBeInstanceOf(DirectoryRefreshSupersededError);
  freshReply.resolve(page);
  await expect(freshFetch).resolves.toBe(page);
  expect(lifetimes).toEqual(["accept:agent", "remove:agent", "accept:agent"]);
});

afterEach(() => {
  for (const serverId of serverIds) useSessionStore.getState().clearSession(serverId);
  serverIds.clear();
});

describe("DirectorySync session readiness", () => {
  it("restores other cached workspaces when a live removal arrives during startup", async () => {
    const serverId = "cache-with-live-removal";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    const workspace = normalizeWorkspaceDescriptor({
      id: "cached-workspace",
      projectId: "cached-project",
      projectDisplayName: "Cached project",
      projectRootPath: "/repo/cached",
      workspaceDirectory: "/repo/cached",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "cached",
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      archivingAt: null,
      diffStat: null,
      scripts: [],
    });
    const { cache, releaseLoad } = await savedDirectory(serverId, {
      agents: new Map(),
      projects: new Map(),
      workspaces: new Map([
        [workspace.id, workspace],
        ["deleted-live", { ...workspace, id: "deleted-live" }],
      ]),
    });
    useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient, 1);
    const directory = new DirectorySync(serverId, noopCallbacks, cache);
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });
    client.emit({ type: "workspace_update", payload: { kind: "remove", id: "deleted-live" } });
    releaseLoad();
    await directory.ready();

    expect([...useSessionStore.getState().sessions[serverId]!.workspaces.keys()]).toEqual([
      workspace.id,
    ]);
    expect(selectWorkspaceDirectoryServerIds(useSessionStore.getState(), [serverId])).toEqual([
      serverId,
    ]);
    expect(client.fetchWorkspacesCalls).toBe(0);
    directory.dispose();
  });

  it("restores the cached directory before network demand", async () => {
    const serverId = "offline-cached-directory";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    const cachedWorkspace = normalizeWorkspaceDescriptor({
      id: "cached-workspace",
      projectId: "cached-project",
      projectDisplayName: "Cached project",
      projectRootPath: "/repo/cached",
      workspaceDirectory: "/repo/cached",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "cached",
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      archivingAt: null,
      diffStat: null,
      scripts: [],
    });
    const cachedProject = normalizeProjectDescriptor({
      projectId: "cached-project",
      projectDisplayName: "Cached project",
      projectRootPath: "/repo/cached",
      projectKind: "git",
    });
    const cachedAgent = createAgent(serverId, "agent-1");
    cachedAgent.workspaceId = cachedWorkspace.id;
    const directory = new DirectorySync(serverId, noopCallbacks, {
      readDirectory: async () => ({
        agents: new Map([[cachedAgent.id, cachedAgent]]),
        workspaces: new Map([[cachedWorkspace.id, cachedWorkspace]]),
        projects: new Map([[cachedProject.projectId, cachedProject]]),
      }),
      commitDirectoryMutations: () => undefined,
    });
    useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient, 1);

    await directory.ready();

    const session = useSessionStore.getState().sessions[serverId];
    expect(session?.hasHydratedAgents).toBe(false);
    expect(session?.agents.get(cachedAgent.id)).toEqual(cachedAgent);
    expect(session?.workspaces.get(cachedWorkspace.id)).toEqual(cachedWorkspace);
    expect(selectWorkspaceDirectoryServerIds(useSessionStore.getState(), [serverId])).toEqual([
      serverId,
    ]);
    expect(client.fetchAgentsCalls).toBe(0);
    expect(client.fetchWorkspacesCalls).toBe(0);
    directory.dispose();
  });

  it("persists accepted script status updates through the directory owner", async () => {
    const serverId = "script-status-owner";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    const commits: DirectoryReplicaMutation[][] = [];
    const directory = new DirectorySync(
      serverId,
      {
        onTimelineRequest: () => () => undefined,
        onAgentStoppedRunning: () => undefined,
        onAgentRemoved: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readDirectory: async () => ({
          agents: new Map(),
          workspaces: new Map(),
          projects: new Map(),
        }),
        commitDirectoryMutations: (_serverId, mutations) => commits.push([...mutations]),
      },
    );
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });
    const workspace = normalizeWorkspaceDescriptor({
      id: "workspace-1",
      projectId: "project-1",
      projectDisplayName: "Paseo",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "running",
      statusEnteredAt: null,
      activityAt: null,
      archivingAt: null,
      diffStat: null,
      scripts: [],
    });
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    await directory.ready();
    directory.acceptWorkspaces([workspace]);
    commits.length = 0;

    client.emit({
      type: "script_status_update",
      payload: {
        workspaceId: workspace.id,
        scripts: [
          {
            scriptName: "web",
            type: "service",
            hostname: "web.paseo.localhost",
            port: 3000,
            proxyUrl: "http://web.paseo.localhost:6767",
            lifecycle: "running",
            health: "healthy",
            exitCode: null,
            terminalId: null,
          },
        ],
      },
    });

    expect(
      useSessionStore.getState().sessions[serverId]?.workspaces.get(workspace.id)?.scripts[0]
        ?.lifecycle,
    ).toBe("running");
    const persisted = commits
      .flat()
      .find(
        (
          mutation,
        ): mutation is Extract<DirectoryReplicaMutation, { kind: "workspace"; type: "upsert" }> =>
          mutation.kind === "workspace" &&
          mutation.type === "upsert" &&
          mutation.id === workspace.id,
      );
    expect(persisted?.value.scripts[0]?.lifecycle).toBe("running");
    directory.dispose();
  });

  it("subscribes to live agent updates when the directory is demanded", async () => {
    const serverId = "demanded-directory-subscription";
    const { client, directory } = createDirectory(serverId);
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true },
    });

    await directory.refreshAll();

    expect(client.lastAgentOptions).toMatchObject({ subscribe: {} });
    directory.dispose();
  });

  it("coalesces overlapping route and full-directory demand", async () => {
    const serverId = "coalesced-directory-demand";
    const { client, directory } = createDirectory(serverId);
    const releaseAgents = client.holdAgentFetch();
    const releaseWorkspaces = client.holdWorkspaceFetch();
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true },
    });

    directory.setAgentRouteDemand(["agent-1"]);
    directory.setDemand({}, true);
    await expect.poll(() => client.fetchAgentsCalls).toBe(1);
    await expect.poll(() => client.fetchWorkspacesCalls).toBe(1);

    releaseAgents({
      requestId: "agents",
      entries: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    });
    releaseWorkspaces({
      requestId: "workspaces",
      entries: [],
      emptyProjects: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    });
    await directory.refreshDemand();

    expect(client.fetchAgentsCalls).toBe(1);
    expect(client.fetchWorkspacesCalls).toBe(1);
    directory.dispose();
  });

  it("publishes cached directory data before the authoritative request completes", async () => {
    const serverId = "cached-directory";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    const releaseNetwork = client.holdWorkspaceFetch();
    let cacheReads = 0;
    const cachedWorkspace = normalizeWorkspaceDescriptor({
      id: "cached-workspace",
      projectId: "cached-project",
      projectDisplayName: "Cached project",
      projectRootPath: "/repo/cached",
      workspaceDirectory: "/repo/cached",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "cached",
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      archivingAt: null,
      diffStat: null,
      scripts: [],
    });
    const cachedProject = normalizeProjectDescriptor({
      projectId: "cached-project",
      projectDisplayName: "Cached project",
      projectRootPath: "/repo/cached",
      projectKind: "git",
    });
    const directory = new DirectorySync(
      serverId,
      {
        onTimelineRequest: () => () => undefined,
        onAgentStoppedRunning: () => undefined,
        onAgentRemoved: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readDirectory: async () => {
          cacheReads += 1;
          return {
            agents: new Map(),
            workspaces: new Map([[cachedWorkspace.id, cachedWorkspace]]),
            projects: new Map([[cachedProject.projectId, cachedProject]]),
          };
        },
        commitDirectoryMutations: () => undefined,
      },
    );
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true },
    });

    const refresh = directory.refreshWorkspaces();
    await expect.poll(() => client.fetchWorkspacesCalls).toBe(1);

    expect(cacheReads).toBe(1);
    expect(
      useSessionStore.getState().sessions[serverId]?.workspaces.get("cached-workspace")?.name,
    ).toBe("cached");

    releaseNetwork({
      requestId: "workspaces",
      entries: [],
      emptyProjects: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    });
    await refresh;
    expect(useSessionStore.getState().sessions[serverId]?.workspaces.size).toBe(0);
    directory.dispose();
  });

  it("reconciles workspace changes on top of the accepted cached baseline", async () => {
    const serverId = "cached-workspace-changes";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    const cachedWorkspace = normalizeWorkspaceDescriptor({
      id: "cached-workspace",
      projectId: "cached-project",
      projectDisplayName: "Cached project",
      projectRootPath: "/repo/cached",
      workspaceDirectory: "/repo/cached",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "cached",
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      archivingAt: null,
      diffStat: null,
      scripts: [],
    });
    const cachedProject = normalizeProjectDescriptor({
      projectId: "cached-project",
      projectDisplayName: "Cached project",
      projectRootPath: "/repo/cached",
      projectKind: "git",
    });
    const releaseNetwork = client.holdWorkspaceFetch();
    const directory = new DirectorySync(
      serverId,
      {
        onTimelineRequest: () => () => undefined,
        onAgentStoppedRunning: () => undefined,
        onAgentRemoved: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readDirectory: async () => ({
          agents: new Map(),
          workspaces: new Map([[cachedWorkspace.id, cachedWorkspace]]),
          projects: new Map([[cachedProject.projectId, cachedProject]]),
          checkpoint: { workspaces: { generation: "g", afterSeq: 7 } },
        }),
        commitDirectoryMutations: () => undefined,
      },
    );
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true, directorySync: true },
    });

    const refresh = directory.refreshWorkspaces();
    await expect.poll(() => client.fetchWorkspacesCalls).toBe(1);
    releaseNetwork({
      requestId: "workspaces",
      entries: [],
      emptyProjects: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      sync: { generation: "g", headSeq: 7, mode: "changes", removals: [] },
    });
    await refresh;

    expect(client.lastWorkspaceOptions).toMatchObject({
      sync: { generation: "g", afterSeq: 7 },
    });
    expect(useSessionStore.getState().sessions[serverId]?.workspaces.has(cachedWorkspace.id)).toBe(
      true,
    );
    directory.dispose();
  });

  it("advances the saved cursor only through completed catch-up", async () => {
    const serverId = "late-directory-cache";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    let releaseCache!: (
      value: Awaited<ReturnType<DirectoryCheckpointStorage["readDirectory"]>>,
    ) => void;
    const cacheRead = new Promise<Awaited<ReturnType<DirectoryCheckpointStorage["readDirectory"]>>>(
      (resolve) => {
        releaseCache = resolve;
      },
    );
    const directory = new DirectorySync(
      serverId,
      {
        onTimelineRequest: () => () => undefined,
        onAgentStoppedRunning: () => undefined,
        onAgentRemoved: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readDirectory: () => cacheRead,
        commitDirectoryMutations: () => undefined,
      },
    );
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true, directorySync: true },
    });

    const releaseNetwork = client.holdWorkspaceFetch();
    const refresh = directory.refreshWorkspaces();
    await Promise.resolve();
    client.emit({
      type: "workspace_update",
      payload: { kind: "remove", id: "deleted-live", generation: "g", seq: 20 },
    });
    releaseCache({
      agents: new Map(),
      workspaces: new Map(),
      projects: new Map(),
      checkpoint: { workspaces: { generation: "g", afterSeq: 7 } },
    });
    releaseNetwork({
      requestId: "catch-up",
      entries: [],
      emptyProjects: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      sync: { generation: "g", headSeq: 20, mode: "changes", removals: [] },
    });
    await refresh;

    expect(client.lastWorkspaceOptions).toMatchObject({
      sync: { generation: "g", afterSeq: 7 },
    });
    client.emit({
      type: "workspace_update",
      payload: { kind: "remove", id: "another-removal", generation: "g", seq: 21 },
    });
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "offline",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 2 },
    });
    client.emit({
      type: "workspace_update",
      payload: { kind: "remove", id: "after-offline-gap", generation: "g", seq: 40 },
    });
    await directory.refreshWorkspaces();
    expect(client.lastWorkspaceOptions).toMatchObject({
      sync: { generation: "g", afterSeq: 20 },
    });
    directory.dispose();
  });

  it("does not resurrect an agent deleted while the baseline is loading", async () => {
    const serverId = "late-agent-cache";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    const cachedAgent = createAgent(serverId, "agent-1");
    const { cache, releaseLoad } = await savedDirectory(serverId, {
      agents: new Map([[cachedAgent.id, cachedAgent]]),
      workspaces: new Map(),
      projects: new Map(),
    });
    useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient, 1);
    const directory = new DirectorySync(serverId, noopCallbacks, cache);
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });

    client.emit({
      type: "agent_deleted",
      payload: { agentId: cachedAgent.id, requestId: "delete-live" },
    });
    releaseLoad();
    await directory.ready();

    expect(useSessionStore.getState().sessions[serverId]?.agents.has(cachedAgent.id)).toBe(false);
    directory.dispose();
  });

  it("requests the authoritative snapshot only after the baseline is restored", async () => {
    const serverId = "late-agent-authoritative-snapshot";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    const cachedAgent = createAgent(serverId, "agent-1");
    const { cache, releaseLoad } = await savedDirectory(serverId, {
      agents: new Map([[cachedAgent.id, cachedAgent]]),
      workspaces: new Map(),
      projects: new Map(),
      checkpoint: { agents: { generation: "g", afterSeq: 5 } },
    });
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { directorySync: true, workspaceMultiplicity: true },
    });
    const directory = new DirectorySync(serverId, noopCallbacks, cache);
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });

    const refresh = directory.refreshAgents();
    await Promise.resolve();
    expect(client.fetchAgentsCalls).toBe(0);
    releaseLoad();
    await refresh;

    expect(client.lastAgentOptions).toMatchObject({
      sync: { generation: "g", afterSeq: 5 },
    });
    expect(useSessionStore.getState().sessions[serverId]?.agents.has(cachedAgent.id)).toBe(false);
    directory.dispose();
  });

  it("uses the saved agent sequence while bounding the bootstrap page", async () => {
    const serverId = "agent-list-sequence-page";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    const directory = new DirectorySync(
      serverId,
      {
        onTimelineRequest: () => () => undefined,
        onAgentStoppedRunning: () => undefined,
        onAgentRemoved: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readDirectory: async () => ({
          agents: new Map(),
          workspaces: new Map(),
          projects: new Map(),
          checkpoint: { agents: { generation: "generation", afterSeq: 12 } },
        }),
        commitDirectoryMutations: () => undefined,
      },
    );
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { directorySync: true, workspaceMultiplicity: true },
    });

    await directory.refreshAgents({
      subscribe: { subscriptionId: `app:${serverId}` },
      page: { limit: 200 },
    });

    expect(client.lastAgentOptions).toEqual({
      scope: "active",
      sort: [{ key: "updated_at", direction: "desc" }],
      subscribe: { subscriptionId: `app:${serverId}` },
      page: { limit: 200 },
      sync: { generation: "generation", afterSeq: 12 },
    });
    directory.dispose();
  });

  it("waits for workspace capability metadata before choosing the workspace protocol", async () => {
    const serverId = "workspace-metadata";
    const { client, directory } = createDirectory(serverId);

    const refresh = directory.refreshWorkspaces({ subscribe: true });
    await Promise.resolve();
    expect(client.fetchWorkspacesCalls).toBe(0);

    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    await Promise.resolve();
    expect(client.fetchWorkspacesCalls).toBe(0);

    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true },
    });
    await refresh;

    expect(client.fetchWorkspacesCalls).toBe(1);
    expect(useSessionStore.getState().sessions[serverId]?.hasHydratedWorkspaces).toBe(true);
    directory.dispose();
  });

  it("fetches the project descriptor channel when the daemon advertises it", async () => {
    const serverId = "project-list";
    const { client, directory } = createDirectory(serverId);
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true, projectList: true },
    });

    await directory.refreshWorkspaces();

    expect(client.listProjectsCalls).toBe(1);
    expect(useSessionStore.getState().sessions[serverId]?.projects.get("project-1")).toMatchObject({
      projectId: "project-1",
      projectKey: "remote:github.com/acme/app",
    });
    directory.dispose();
  });

  it("merges project changes from the existing list RPC and advances its cursor", async () => {
    const serverId = "project-list-sequence";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    const writes: Array<{
      mutations: readonly DirectoryReplicaMutation[];
      checkpoint: unknown;
    }> = [];
    const cachedProjects = [
      normalizeProjectDescriptor({
        projectId: "project-1",
        projectDisplayName: "Old name",
        projectRootPath: "/repo/one",
        projectKind: "git",
      }),
      normalizeProjectDescriptor({
        projectId: "project-2",
        projectDisplayName: "Removed",
        projectRootPath: "/repo/two",
        projectKind: "git",
      }),
      normalizeProjectDescriptor({
        projectId: "untouched-project",
        projectDisplayName: "Untouched",
        projectRootPath: "/repo/untouched",
        projectKind: "git",
      }),
    ];
    const directory = new DirectorySync(
      serverId,
      {
        onTimelineRequest: () => () => undefined,
        onAgentStoppedRunning: () => undefined,
        onAgentRemoved: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readDirectory: async () => ({
          agents: new Map(),
          workspaces: new Map(),
          projects: new Map(cachedProjects.map((project) => [project.projectId, project])),
          checkpoint: { projects: { generation: "generation", afterSeq: 4 } },
        }),
        commitDirectoryMutations: (_serverId, mutations, checkpoint) =>
          writes.push({ mutations: [...mutations], checkpoint }),
      },
    );
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true, projectList: true, directorySync: true },
    });
    client.projectResult = {
      requestId: "projects",
      projects: [
        {
          projectId: "project-1",
          projectDisplayName: "New name",
          projectRootPath: "/repo/one",
          projectKind: "git",
          syncSeq: 5,
        },
      ],
      sync: {
        generation: "generation",
        headSeq: 6,
        mode: "changes",
        removals: [{ id: "project-2", seq: 6 }],
      },
    };

    await directory.refreshWorkspaces();

    expect(client.lastProjectOptions).toEqual({
      sync: { generation: "generation", afterSeq: 4 },
    });
    const projects = useSessionStore.getState().sessions[serverId]?.projects;
    expect(Array.from(projects?.keys() ?? [])).toEqual(["project-1", "untouched-project"]);
    expect(projects?.get("project-1")?.projectDisplayName).toBe("New name");
    expect(writes.map(({ checkpoint }) => checkpoint)).toContainEqual({
      projects: { generation: "generation", afterSeq: 6 },
    });
    const writtenProjectIds = writes
      .flatMap(({ mutations }) => mutations)
      .filter((mutation) => mutation.kind === "project")
      .map((mutation) => mutation.id);
    expect(writtenProjectIds).toEqual(["project-1", "project-2"]);
    expect(writtenProjectIds).not.toContain("untouched-project");
    directory.dispose();
  });

  it("rejects a session wait on disconnect so the reconnect can refresh", async () => {
    const serverId = "session-wait-reconnect";
    const { client, directory } = createDirectory(serverId);
    const staleRefresh = directory.refreshAgents();
    await Promise.resolve();

    directory.connectionChanged({
      client: null,
      status: "offline",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });
    await expect(staleRefresh).rejects.toBeInstanceOf(DirectoryRefreshSupersededError);

    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 2 },
    });
    const currentRefresh = directory.refreshAgents();
    useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient, 1);
    await currentRefresh;

    expect(client.fetchAgentsCalls).toBe(1);
    directory.dispose();
  });

  it("buffers workspace and project updates in the same hydration transaction", async () => {
    const serverId = "workspace-project-transaction";
    const { client, directory } = createDirectory(serverId);
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true },
    });
    const completeFetch = client.holdWorkspaceFetch();

    const refresh = directory.refreshWorkspaces({ subscribe: true });
    await Promise.resolve();
    client.emit({
      type: "workspace_update",
      payload: {
        kind: "remove",
        id: "removed-workspace",
        emptyProject: {
          projectId: "workspace-project",
          projectDisplayName: "Project from workspace update",
          projectRootPath: "/repo/workspace-project",
          projectKind: "git",
        },
      },
    });
    client.emit({
      type: "project.update",
      payload: {
        kind: "upsert",
        project: {
          projectId: "snapshot-project",
          projectDisplayName: "Renamed during hydration",
          projectRootPath: "/moved/snapshot-project",
          projectKind: "directory",
        },
      },
    });
    completeFetch({
      requestId: "workspaces",
      entries: [],
      emptyProjects: [
        {
          projectId: "snapshot-project",
          projectDisplayName: "Stale snapshot project",
          projectRootPath: "/repo/snapshot-project",
          projectKind: "git",
        },
      ],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    });
    await refresh;

    const projects = useSessionStore.getState().sessions[serverId]?.projects;
    expect(Array.from(projects?.keys() ?? [])).toEqual(["snapshot-project", "workspace-project"]);
    expect(projects?.get("snapshot-project")).toMatchObject({
      projectDisplayName: "Renamed during hydration",
      projectRootPath: "/moved/snapshot-project",
      projectKind: "directory",
    });
    expect(projects?.get("workspace-project")).toMatchObject({
      projectDisplayName: "Project from workspace update",
    });
    directory.dispose();
  });

  it("buffers project updates from the online epoch before workspace hydration starts", async () => {
    const serverId = "project-before-workspace-hydration";
    const { client, directory } = createDirectory(serverId);
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true },
    });

    client.emit({
      type: "project.update",
      payload: {
        kind: "upsert",
        project: {
          projectId: "early-project",
          projectDisplayName: "Early project",
          projectRootPath: "/repo/early-project",
          projectKind: "git",
        },
      },
    });

    expect(useSessionStore.getState().sessions[serverId]?.hasHydratedWorkspaces).toBe(false);

    await directory.refreshWorkspaces({ subscribe: true });

    expect(useSessionStore.getState().sessions[serverId]?.hasHydratedWorkspaces).toBe(true);
    expect(
      useSessionStore.getState().sessions[serverId]?.projects.get("early-project"),
    ).toMatchObject({
      projectDisplayName: "Early project",
      projectRootPath: "/repo/early-project",
    });
    directory.dispose();
  });
});
