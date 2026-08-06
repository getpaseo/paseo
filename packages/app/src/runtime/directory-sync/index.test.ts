import { afterEach, describe, expect, it } from "vitest";
import type {
  DaemonClient,
  FetchAgentsEntry,
  FetchAgentsOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { DirectoryRefreshSupersededError, DirectorySync } from "./index";

type WorkspaceFetchResult = Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>;
type ProjectListResult = Awaited<ReturnType<DaemonClient["listProjects"]>>;
type AgentFetchResult = Awaited<ReturnType<DaemonClient["fetchAgents"]>>;

class FakeDirectoryClient {
  fetchAgentsCalls = 0;
  fetchWorkspacesCalls = 0;
  listProjectsCalls = 0;
  fetchAgentsOptions: FetchAgentsOptions[] = [];
  private queuedAgentFetch: AgentFetchResult[] = [];
  private pendingWorkspaceFetch: Promise<WorkspaceFetchResult> | null = null;
  private readonly handlers = new Map<
    SessionOutboundMessage["type"],
    Set<(message: SessionOutboundMessage) => void>
  >();

  queueFetchAgents(result: AgentFetchResult): void {
    this.queuedAgentFetch.push(result);
  }

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

  async fetchAgents(options?: FetchAgentsOptions): Promise<AgentFetchResult> {
    this.fetchAgentsCalls += 1;
    this.fetchAgentsOptions.push(options ?? {});
    const queued = this.queuedAgentFetch.shift();
    if (queued) return queued;
    return {
      requestId: "agents",
      entries: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    };
  }

  async fetchWorkspaces(): Promise<WorkspaceFetchResult> {
    this.fetchWorkspacesCalls += 1;
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

  async listProjects(): Promise<ProjectListResult> {
    this.listProjectsCalls += 1;
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
}

const serverIds = new Set<string>();

function makeFetchAgentsEntry(input: {
  id: string;
  cwd: string;
  updatedAt: string;
  title?: string | null;
  requiresAttention?: boolean;
  attentionReason?: "permission" | "error" | null;
  archivedAt?: string | null;
}): FetchAgentsEntry {
  return {
    agent: {
      id: input.id,
      provider: "codex",
      status: "idle",
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
      lastUserMessageAt: null,
      lastError: undefined,
      runtimeInfo: {
        provider: "codex",
        sessionId: null,
      },
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
      title: input.title ?? null,
      cwd: input.cwd,
      model: null,
      thinkingOptionId: null,
      requiresAttention: input.requiresAttention ?? false,
      attentionReason: input.attentionReason ?? null,
      attentionTimestamp: input.requiresAttention && input.attentionReason ? input.updatedAt : null,
      archivedAt: input.archivedAt ?? null,
      labels: {},
    },
    project: {
      projectKey: input.cwd,
      projectName: "workspace",
      checkout: {
        cwd: input.cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

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

afterEach(() => {
  for (const serverId of serverIds) useSessionStore.getState().clearSession(serverId);
  serverIds.clear();
});

describe("DirectorySync session readiness", () => {
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

  it("resyncs incrementally after a reconnect using the sequence cursor", async () => {
    const serverId = "incremental-resync";
    const { client, directory } = createDirectory(serverId);
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true },
    });

    const agentA = makeFetchAgentsEntry({
      id: "agent-a",
      cwd: "/repo",
      updatedAt: "2026-07-12T10:00:00.000Z",
      title: "a",
    });
    client.queueFetchAgents({
      requestId: "full",
      entries: [agentA],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      sequence: 5,
      directoryGeneration: "gen-1",
    });
    await directory.refreshAgents();
    expect(useSessionStore.getState().sessions[serverId]?.agents.has("agent-a")).toBe(true);

    // 模拟重连：新的 connection epoch，客户端带着旧 cursor 增量续拉
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 2 },
    });

    const agentAUpdated = makeFetchAgentsEntry({
      id: "agent-a",
      cwd: "/repo",
      updatedAt: "2026-07-12T10:00:05.000Z",
      title: "a-v2",
    });
    const agentB = makeFetchAgentsEntry({
      id: "agent-b",
      cwd: "/repo",
      updatedAt: "2026-07-12T10:00:06.000Z",
      title: "b",
    });
    client.queueFetchAgents({
      requestId: "incr",
      entries: [agentAUpdated, agentB],
      deletedIds: ["agent-c"],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      sequence: 8,
      directoryGeneration: "gen-1",
      incremental: true,
    });
    await directory.refreshAgents();

    expect(client.fetchAgentsCalls).toBe(2);
    expect(client.fetchAgentsOptions[1]).toMatchObject({
      scope: "active",
      afterSequence: 5,
      directoryGeneration: "gen-1",
    });
    const agents = useSessionStore.getState().sessions[serverId]?.agents;
    expect(agents?.get("agent-a")).toMatchObject({ title: "a-v2" });
    expect(agents?.has("agent-b")).toBe(true);
    expect(agents?.has("agent-c")).toBe(false);
    directory.dispose();
  });

  it("falls back to a full snapshot when the daemon generation changes", async () => {
    const serverId = "generation-change";
    const { client, directory } = createDirectory(serverId);
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true },
    });

    const agentA = makeFetchAgentsEntry({
      id: "agent-a",
      cwd: "/repo",
      updatedAt: "2026-07-12T10:00:00.000Z",
      title: "a",
    });
    client.queueFetchAgents({
      requestId: "full",
      entries: [agentA],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      sequence: 5,
      directoryGeneration: "gen-1",
    });
    await directory.refreshAgents();

    // daemon 重启：generation 变了，增量请求被拒绝
    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 3 },
    });
    client.queueFetchAgents({
      requestId: "reject",
      entries: [],
      deletedIds: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      sequence: 0,
      directoryGeneration: "gen-2",
      incremental: false,
    });
    // 全量兜底：gen-2 下当前 active 快照
    const agentA2 = makeFetchAgentsEntry({
      id: "agent-a",
      cwd: "/repo",
      updatedAt: "2026-07-12T10:00:10.000Z",
      title: "a-v2",
    });
    client.queueFetchAgents({
      requestId: "full2",
      entries: [agentA2],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      sequence: 0,
      directoryGeneration: "gen-2",
    });

    await directory.refreshAgents();

    // 第 2 次调用是带 cursor 的增量尝试，被拒后第 3 次退化为无 cursor 的全量
    expect(client.fetchAgentsCalls).toBe(3);
    expect(client.fetchAgentsOptions[1]).toMatchObject({
      afterSequence: 5,
      directoryGeneration: "gen-1",
    });
    expect(client.fetchAgentsOptions[2].afterSequence).toBeUndefined();
    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent-a")).toMatchObject({
      title: "a-v2",
    });
    directory.dispose();
  });
});
