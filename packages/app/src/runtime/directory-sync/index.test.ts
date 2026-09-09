import { DatabaseSync } from "node:sqlite";
import { ReplicaCache } from "@/runtime/replica-cache";
import {
  createSqliteReplicaRowStore,
  type ReplicaSqliteConnection,
  type SqliteValue,
} from "@/runtime/replica-cache/row-store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
} from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { selectWorkspaceDirectoryServerIds } from "@/stores/session-store-hooks/selectors";
import type { DirectoryReplicaMutation } from "@/runtime/replica-cache";
import {
  DirectoryRefreshSupersededError,
  DirectorySync,
  type DirectoryCheckpointStorage,
} from "./index";

type WorkspaceFetchResult = Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>;
type ProjectListResult = Awaited<ReturnType<DaemonClient["listProjects"]>>;
type AgentFetchResult = Awaited<ReturnType<DaemonClient["fetchAgents"]>>;

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

const serverIds = new Set<string>();

function createDirectory(serverId: string): {
  client: FakeDirectoryClient;
  directory: DirectorySync;
} {
  serverIds.add(serverId);
  const client = new FakeDirectoryClient();
  const directory = new DirectorySync(serverId, {
    onAgentStoppedRunning: () => undefined,
    markAgentLoading: () => undefined,
    markAgentReady: () => undefined,
    markAgentError: () => undefined,
  });
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

afterEach(() => {
  for (const serverId of serverIds) useSessionStore.getState().clearSession(serverId);
  serverIds.clear();
});

describe("DirectorySync session readiness", () => {
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
    const directory = new DirectorySync(
      serverId,
      {
        onAgentStoppedRunning: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readAgent: async () => undefined,
        readWorkspace: async () => undefined,
        readDirectory: async () => ({
          agents: new Map(),
          workspaces: new Map([[cachedWorkspace.id, cachedWorkspace]]),
          projects: new Map([[cachedProject.projectId, cachedProject]]),
        }),
        commitDirectoryMutations: () => undefined,
      },
    );
    useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient, 1);

    await directory.restoreCachedDirectory();

    expect(
      useSessionStore.getState().sessions[serverId]?.workspaces.get(cachedWorkspace.id),
    ).toEqual(cachedWorkspace);
    expect(selectWorkspaceDirectoryServerIds(useSessionStore.getState(), [serverId])).toEqual([
      serverId,
    ]);
    expect(client.fetchAgentsCalls).toBe(0);
    expect(client.fetchWorkspacesCalls).toBe(0);
    directory.dispose();
  });

  it("prepares a cached agent workspace route without sidebar demand", async () => {
    const serverId = "cached-agent-route";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    const cachedAgent = createAgent(serverId, "agent-1");
    const cachedWorkspace = normalizeWorkspaceDescriptor({
      id: "workspace-1",
      projectId: "project-1",
      projectDisplayName: "Paseo",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      archivingAt: null,
      diffStat: null,
      scripts: [],
    });
    cachedAgent.workspaceId = cachedWorkspace.id;
    const directory = new DirectorySync(
      serverId,
      {
        onAgentStoppedRunning: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readAgent: async () => cachedAgent,
        readWorkspace: async () => ({ workspace: cachedWorkspace }),
        readDirectory: async () => ({
          agents: new Map(),
          workspaces: new Map(),
          projects: new Map(),
        }),
        commitDirectoryMutations: () => undefined,
      },
    );
    useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient, 1);

    await directory.prepareAgentRoute(cachedAgent.id);

    const session = useSessionStore.getState().sessions[serverId];
    expect(session?.hasHydratedAgents).toBe(false);
    expect(session?.hasWorkspaceDirectorySnapshot).toBe(false);
    expect(session?.agents.get(cachedAgent.id)).toEqual(cachedAgent);
    expect(session?.workspaces.get(cachedWorkspace.id)).toEqual(cachedWorkspace);
    expect(client.fetchAgentsCalls).toBe(0);
    expect(client.fetchWorkspacesCalls).toBe(0);
    directory.dispose();
  });

  it("persists accepted script status updates through the directory owner", () => {
    const serverId = "script-status-owner";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    const commits: DirectoryReplicaMutation[][] = [];
    const directory = new DirectorySync(
      serverId,
      {
        onAgentStoppedRunning: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readAgent: async () => undefined,
        readWorkspace: async () => undefined,
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
        onAgentStoppedRunning: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readAgent: async () => undefined,
        readWorkspace: async () => undefined,
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
        onAgentStoppedRunning: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readAgent: async () => undefined,
        readWorkspace: async () => undefined,
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

  it("does not use a cached checkpoint when the corresponding cache read loses its race", async () => {
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
        onAgentStoppedRunning: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readAgent: async () => undefined,
        readWorkspace: async () => undefined,
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

    const refresh = directory.refreshWorkspaces();
    await Promise.resolve();
    client.emit({
      type: "workspace_update",
      payload: { kind: "remove", id: "deleted-live" },
    });
    releaseCache({
      agents: new Map(),
      workspaces: new Map(),
      projects: new Map(),
      checkpoint: { workspaces: { generation: "stale", afterSeq: 99 } },
    });
    await refresh;

    expect(client.lastWorkspaceOptions).not.toHaveProperty("sync.generation");
    directory.dispose();
  });

  it("does not resurrect an agent deleted while its targeted cache row is loading", async () => {
    const serverId = "late-agent-cache";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    const cachedAgent = {
      ...normalizeAgentSnapshot(
        {
          id: "agent-1",
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
    let releaseAgent!: (agent: typeof cachedAgent) => void;
    const agentRead = new Promise<typeof cachedAgent>((resolve) => {
      releaseAgent = resolve;
    });
    const directory = new DirectorySync(
      serverId,
      {
        onAgentStoppedRunning: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readAgent: () => agentRead,
        readWorkspace: async () => undefined,
        readDirectory: async () => ({
          agents: new Map(),
          workspaces: new Map(),
          projects: new Map(),
        }),
        commitDirectoryMutations: () => undefined,
      },
    );
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });
    useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient, 1);

    const load = directory.loadCachedAgent(cachedAgent.id);
    client.emit({
      type: "agent_deleted",
      payload: { agentId: cachedAgent.id, requestId: "delete-live" },
    });
    releaseAgent(cachedAgent);
    await load;

    expect(useSessionStore.getState().sessions[serverId]?.agents.has(cachedAgent.id)).toBe(false);
    directory.dispose();
  });

  it("does not resurrect an agent removed by an authoritative snapshot while cache loads", async () => {
    const serverId = "late-agent-authoritative-snapshot";
    serverIds.add(serverId);
    const client = new FakeDirectoryClient();
    const cachedAgent = createAgent(serverId, "agent-1");
    const releaseNetwork = client.holdAgentFetch();
    let releaseAgent!: (agent: typeof cachedAgent) => void;
    const agentRead = new Promise<typeof cachedAgent>((resolve) => {
      releaseAgent = resolve;
    });
    const directory = new DirectorySync(
      serverId,
      {
        onAgentStoppedRunning: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readAgent: () => agentRead,
        readWorkspace: async () => undefined,
        readDirectory: async () => ({
          agents: new Map(),
          workspaces: new Map(),
          projects: new Map(),
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

    const refresh = directory.refreshAgents();
    const load = directory.loadCachedAgent(cachedAgent.id);
    releaseNetwork({
      requestId: "authoritative-snapshot",
      entries: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    });
    await refresh;
    releaseAgent(cachedAgent);
    await load;

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
        onAgentStoppedRunning: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readAgent: async () => undefined,
        readWorkspace: async () => undefined,
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
        onAgentStoppedRunning: () => undefined,
        markAgentLoading: () => undefined,
        markAgentReady: () => undefined,
        markAgentError: () => undefined,
      },
      {
        readAgent: async () => undefined,
        readWorkspace: async () => undefined,
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

function createSqliteCache() {
  const database = new DatabaseSync(":memory:");
  let beforeRead = async () => {};
  const connection: ReplicaSqliteConnection = {
    async exec(sql) {
      database.exec(sql);
    },
    async run(sql, params = []) {
      database.prepare(sql).run(...params);
    },
    async all<Row>(sql: string, params: readonly SqliteValue[] = []) {
      const rows = database.prepare(sql).all(...params) as Row[];
      if (sql.includes("FROM rows") && sql.includes("WHERE")) await beforeRead();
      return rows;
    },
    async transaction(operation) {
      database.exec("BEGIN IMMEDIATE");
      try {
        await operation(connection);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const storage = createSqliteReplicaRowStore({ open: async () => connection }, 1);
  const cache = new ReplicaCache(storage, { clearLegacyCache: async () => {} });
  return {
    cache,
    database,
    holdRead: (operation: () => Promise<void>) => {
      beforeRead = operation;
    },
  };
}

it("fills every cached workspace beneath live updates received during the SQLite read", async () => {
  const serverId = "sqlite-directory-race";
  serverIds.add(serverId);
  const { cache, database, holdRead } = createSqliteCache();
  cache.setHosts([serverId]);
  const project = normalizeProjectDescriptor({
    projectId: "project",
    projectDisplayName: "Cached",
    projectRootPath: "/repo",
    projectKind: "git",
  });
  const workspaces = ["first", "second", "third"].map((id) =>
    normalizeWorkspaceDescriptor({
      id,
      projectId: "project",
      projectDisplayName: "Cached",
      projectRootPath: "/repo",
      workspaceDirectory: `/repo/${id}`,
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: id,
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      archivingAt: null,
      diffStat: null,
      scripts: [],
    }),
  );
  cache.replaceDirectoryBaseline(serverId, {
    agents: new Map([["agent", createAgent(serverId, "agent")]]),
    workspaces: new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    projects: new Map([[project.projectId, project]]),
  });
  await cache.flush();
  const client = new FakeDirectoryClient();
  const directory = new DirectorySync(
    serverId,
    {
      onAgentStoppedRunning: () => {},
      markAgentLoading: () => {},
      markAgentReady: () => {},
      markAgentError: () => {},
    },
    cache,
  );
  useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient, 1);
  directory.connectionChanged({
    client: client as unknown as DaemonClient,
    status: "online",
    source: { clientGeneration: 1, connectionEpoch: 1 },
  });
  let updated = false;
  holdRead(async () => {
    if (updated) return;
    updated = true;
    client.emit({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: { ...workspaces[0], name: "Live", activityAt: null, statusEnteredAt: null },
      },
    });
  });
  await directory.restoreCachedDirectory();
  const session = useSessionStore.getState().sessions[serverId];
  expect(
    [...session.workspaces.values()]
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  ).toEqual([
    { id: "first", name: "Live" },
    { id: "second", name: "second" },
    { id: "third", name: "third" },
  ]);
  expect(session.agents.get("agent")?.title).toBe("Cached");
  expect(session.hasWorkspaceDirectorySnapshot).toBe(true);
  directory.dispose();
  await cache.flush();
  database.close();
});
