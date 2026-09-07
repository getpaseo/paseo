import type {
  DaemonClient,
  FetchAgentsEntry,
  FetchAgentsOptions,
} from "@getpaseo/client/internal/daemon-client";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type Agent,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import {
  readLegacyDaemonWorkspaceDirectory,
  buildLegacyWorkspaces,
  shouldUseLegacyDaemonWorkspaceDirectory,
  stampLegacyWorkspaceIds,
} from "@/workspace/legacy-daemon-workspaces";
import type { AgentDirectoryDelta, AgentRemovalReason } from "@/utils/agent-directory-sync";
import { AgentDirectoryReplica } from "./agent-replica";
import {
  WorkspaceDirectoryReplica,
  type WorkspaceDirectoryDelta,
  type WorkspaceDirectorySnapshot,
} from "./workspace-replica";
import {
  DirectoryTransactionOwner,
  type DirectorySourceToken,
  type DirectoryTransaction,
} from "./transaction";
import { workspaceLabels } from "@/workspace-labels";
import type {
  CachedDirectory,
  DirectoryCheckpoint,
  DirectoryCursor,
  DirectoryReplicaMutation,
} from "@/runtime/replica-cache";
import type { TurnLivenessTransition } from "@/timeline/turn-liveness";

type TimelinePage = Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>;

const PAGE_LIMIT = 200;
const AGENT_SORT: NonNullable<FetchAgentsOptions["sort"]> = [
  { key: "updated_at", direction: "desc" },
];

function resolveAgentNextPage(pageInfo: AgentPageInfo): {
  hasMore: boolean;
  nextCursor: string | null;
} {
  return {
    hasMore: pageInfo.hasMore ?? pageInfo.hasMoreAfter ?? false,
    nextCursor: pageInfo.nextCursor ?? pageInfo.afterCursor ?? null,
  };
}

interface AgentSnapshot {
  entries: FetchAgentsEntry[];
  subscriptionId: string | null;
  legacy: boolean;
  syncMode?: "snapshot" | "changes";
  syncCursor?: DirectoryCursor;
  syncRemovals: Array<{ id: string; seq: number }>;
}

interface AgentPageInfo {
  hasMore?: boolean;
  hasMoreAfter?: boolean;
  nextCursor?: string | null;
  afterCursor?: string | null;
}

function applyWorkspaceSnapshotPage(
  snapshot: WorkspaceDirectorySnapshot,
  payload: Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>,
  firstPage: boolean,
): void {
  if (firstPage && payload.sync?.mode !== "changes") snapshot.workspaces.clear();
  if (firstPage) (snapshot.syncModes ??= {}).workspaces = payload.sync?.mode ?? "snapshot";
  for (const entry of payload.entries) {
    const workspace = normalizeWorkspaceDescriptor(entry);
    snapshot.workspaces.set(workspace.id, workspace);
    (snapshot.touchedWorkspaceIds ??= new Set()).add(workspace.id);
    (snapshot.touchedProjectIds ??= new Set()).add(workspace.projectId);
  }
  for (const removal of payload.sync?.removals ?? []) {
    snapshot.workspaces.delete(removal.id);
    (snapshot.touchedWorkspaceIds ??= new Set()).add(removal.id);
  }
  if (payload.sync) {
    (snapshot.syncCursors ??= {}).workspaces = {
      generation: payload.sync.generation,
      afterSeq: payload.sync.headSeq,
    };
  }
  for (const entry of payload.emptyProjects ?? []) {
    const project = normalizeProjectDescriptor(entry);
    snapshot.projects.set(project.projectId, project);
    (snapshot.touchedProjectIds ??= new Set()).add(project.projectId);
  }
}

export interface DirectoryConnection {
  client: DaemonClient | null;
  status: "online" | "offline";
  source: DirectorySourceToken;
}

export interface DirectoryCheckpointStorage {
  readDirectory(serverId: string): Promise<CachedDirectory>;
  commitDirectoryMutations(
    serverId: string,
    mutations: readonly DirectoryReplicaMutation[],
    checkpoint?: DirectoryCheckpoint,
  ): void;
  replaceDirectoryBaseline?(serverId: string, directory: CachedDirectory): void;
}

export interface RefreshAgentDirectoryInput {
  filter?: FetchAgentsOptions["filter"];
  subscribe?: FetchAgentsOptions["subscribe"];
  page?: FetchAgentsOptions["page"];
}

export interface RefreshAgentDirectoryResult {
  agents: Map<string, Agent>;
  subscriptionId: string | null;
}

export class DirectorySync {
  private readonly agentTransactions = new DirectoryTransactionOwner<
    AgentSnapshot,
    AgentDirectoryDelta
  >();
  private readonly workspaceTransactions = new DirectoryTransactionOwner<
    WorkspaceDirectorySnapshot,
    WorkspaceDirectoryDelta
  >();
  private readonly timelineRequests = new Map<string, Promise<TimelinePage>>();
  private readonly agents: AgentDirectoryReplica;
  private readonly workspaces: WorkspaceDirectoryReplica;
  private connection: DirectoryConnection = {
    client: null,
    status: "offline",
    source: { clientGeneration: 0, connectionEpoch: 0 },
  };
  private unsubscribe: (() => void) | null = null;
  private readonly abortSessionWaits = new Set<() => void>();
  // The saved baseline is restored once, at construction. Live mutations apply as they arrive and
  // the baseline merges under them; network refreshes wait for it so their transactions and
  // cursors start from the saved state.
  private readonly baseline: Promise<void>;
  private readonly routeDemandIds = new Set<string>();
  private readonly fullDemandSources = new Set<object>();
  private demandRefresh: Promise<void> | null = null;
  private satisfiedDemandSource: DirectorySourceToken | null = null;
  private cursors: DirectoryCheckpoint = {};

  constructor(
    private readonly serverId: string,
    private readonly callbacks: {
      onTimelineRequest: (agentId: string, replaceTail: boolean) => (page: TimelinePage) => void;
      onAgentStoppedRunning: (agentId: string) => void;
      onAgentRemoved: (agentId: string, reason: AgentRemovalReason) => void;
      onAgentAccepted?: (agentId: string) => void;
      markAgentLoading: () => void;
      markAgentReady: () => void;
      markAgentError: (error: string) => void;
    },
    private readonly checkpoints?: DirectoryCheckpointStorage,
  ) {
    const persist = (mutations: readonly DirectoryReplicaMutation[]) =>
      this.checkpoints?.commitDirectoryMutations(this.serverId, mutations);
    this.agents = new AgentDirectoryReplica(
      serverId,
      callbacks.onAgentStoppedRunning,
      persist,
      callbacks.onAgentRemoved,
      callbacks.onAgentAccepted,
    );
    this.workspaces = new WorkspaceDirectoryReplica(serverId);
    this.baseline = this.restoreBaseline().catch(() => undefined);
  }

  ready(): Promise<void> {
    return this.baseline;
  }

  connectionChanged(connection: DirectoryConnection): boolean {
    const changed =
      this.connection.client !== connection.client ||
      this.connection.source.clientGeneration !== connection.source.clientGeneration ||
      this.connection.source.connectionEpoch !== connection.source.connectionEpoch;
    const wentOffline = this.connection.status === "online" && connection.status === "offline";
    if (!changed && !wentOffline) {
      this.connection = connection;
      return false;
    }
    this.flushAbortedTransactions();
    this.timelineRequests.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    workspaceLabels.disconnect(this.serverId);
    this.connection = connection;
    this.abortPendingSessionWaits();
    if (!connection.client || connection.status !== "online") return true;
    const client = connection.client;
    const source = connection.source;
    const subscriptions = [
      client.on("agent_update", (message) => {
        if (message.type !== "agent_update" || !this.isCurrent(client, source)) return;
        if (!this.agentTransactions.record(source, message.payload)) {
          this.agents.applyDelta(message.payload);
        }
      }),
      client.on("workspace_update", (message) => {
        if (message.type !== "workspace_update" || !this.isCurrent(client, source)) return;
        if (!this.workspaceTransactions.record(source, message.payload)) {
          this.applyWorkspaceDelta(message.payload);
        }
      }),
      client.on("project.update", (message) => {
        if (message.type !== "project.update" || !this.isCurrent(client, source)) return;
        if (!this.workspaceTransactions.record(source, message.payload)) {
          this.applyWorkspaceDelta(message.payload);
        }
      }),
      client.on("script_status_update", (message) => {
        if (message.type !== "script_status_update" || !this.isCurrent(client, source)) return;
        const delta: WorkspaceDirectoryDelta = {
          kind: "script_status",
          update: message.payload,
        };
        if (!this.workspaceTransactions.record(source, delta)) {
          this.applyWorkspaceDelta(delta);
        }
      }),
      client.on("agent_deleted", (message) => {
        if (message.type !== "agent_deleted" || !this.isCurrent(client, source)) return;
        this.agents.remove(message.payload.agentId);
      }),
      client.on("agent_archived", (message) => {
        if (message.type !== "agent_archived" || !this.isCurrent(client, source)) return;
        this.agents.archive(message.payload.agentId, message.payload.archivedAt);
      }),
    ];
    this.unsubscribe = () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
    if (this.hasDemand()) void this.requestDemandRefresh().catch(() => undefined);
    return true;
  }

  setDemand(source: object, demanded: boolean): void {
    const wasDemanded = this.fullDemandSources.size > 0;
    if (demanded) this.fullDemandSources.add(source);
    else this.fullDemandSources.delete(source);
    if (!wasDemanded && this.fullDemandSources.size > 0 && this.getOnlineConnection()) {
      void this.requestDemandRefresh().catch(() => undefined);
    }
  }

  setAgentRouteDemand(agentIds: readonly string[]): void {
    const next = new Set(agentIds);
    if (
      next.size === this.routeDemandIds.size &&
      [...next].every((agentId) => this.routeDemandIds.has(agentId))
    ) {
      return;
    }
    this.routeDemandIds.clear();
    for (const agentId of next) this.routeDemandIds.add(agentId);
    if (this.routeDemandIds.size > 0 && this.getOnlineConnection()) {
      void this.requestDemandRefresh().catch(() => undefined);
    }
  }

  dispose(): void {
    this.connection = { ...this.connection, status: "offline" };
    this.timelineRequests.clear();
    this.flushAbortedTransactions();
    this.abortPendingSessionWaits();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.fullDemandSources.clear();
    this.routeDemandIds.clear();
    workspaceLabels.disconnect(this.serverId);
  }

  private hasDemand(): boolean {
    return this.fullDemandSources.size > 0 || this.routeDemandIds.size > 0;
  }

  private requestDemandRefresh(force = false): Promise<void> {
    if (this.demandRefresh) return this.demandRefresh;
    if (!this.hasDemand()) return Promise.resolve();
    if (!this.getOnlineConnection()) return this.baseline;
    const source = this.connection.source;
    if (
      !force &&
      this.satisfiedDemandSource?.clientGeneration === source.clientGeneration &&
      this.satisfiedDemandSource.connectionEpoch === source.connectionEpoch
    ) {
      return Promise.resolve();
    }
    const refresh =
      this.fullDemandSources.size > 0
        ? this.refreshAll()
        : Promise.all([
            this.refreshAgents({ subscribe: {} }),
            this.refreshWorkspaces({ subscribe: true }),
          ]).then(() => undefined);
    this.demandRefresh = refresh
      .then(() => {
        this.satisfiedDemandSource = source;
        return undefined;
      })
      .finally(() => {
        this.demandRefresh = null;
        const current = this.connection.source;
        if (
          this.hasDemand() &&
          (current.clientGeneration !== source.clientGeneration ||
            current.connectionEpoch !== source.connectionEpoch)
        ) {
          void this.requestDemandRefresh().catch(() => undefined);
        }
      });
    return this.demandRefresh;
  }

  refreshDemand(): Promise<void> {
    return this.requestDemandRefresh(true);
  }

  private async restoreBaseline(): Promise<void> {
    if (!this.checkpoints) return;
    const cached = await this.checkpoints.readDirectory(this.serverId);
    if (!useSessionStore.getState().sessions[this.serverId]) return;
    this.agents.commitCached(cached.agents);
    this.workspaces.commitCached(cached);
    this.cursors = cached.checkpoint ?? {};
  }

  applyAgentTurnLiveness(
    agentId: string,
    transition: TurnLivenessTransition | readonly TurnLivenessTransition[],
  ): void {
    this.agents.applyTurnLiveness(agentId, transition);
  }

  acceptAgent(agent: Agent): Agent {
    return this.agents.accept(agent);
  }

  async fetchTimeline(
    agentId: string,
    request: Parameters<DaemonClient["fetchAgentTimeline"]>[1],
    replaceTail = false,
  ): Promise<TimelinePage> {
    const { client, source } = this.requireOnline();
    const token = this.agents.captureTimeline(agentId);
    const key = JSON.stringify({ agentId, lifetime: token.version, request, replaceTail });
    const existing = this.timelineRequests.get(key);
    if (existing) return existing;
    const apply = this.callbacks.onTimelineRequest(agentId, replaceTail);
    const fetching = client.fetchAgentTimeline(agentId, request).then((page) => {
      if (!this.isCurrent(client, source) || !this.agents.isTimelineCurrent(token)) {
        throw new DirectoryRefreshSupersededError("timeline page no longer current");
      }
      if (page.agent) this.agents.submitTimelineAgent(token, page.agent);
      apply(page);
      return page;
    });
    this.timelineRequests.set(key, fetching);
    const clear = () => {
      if (this.timelineRequests.get(key) === fetching) this.timelineRequests.delete(key);
    };
    void fetching.then(clear, clear);
    return fetching;
  }

  async refreshAgents(
    input: RefreshAgentDirectoryInput = {},
  ): Promise<RefreshAgentDirectoryResult> {
    const onlineConnection = this.getOnlineConnection();
    if (!onlineConnection) {
      await this.baseline;
      this.callbacks.markAgentReady();
      return {
        agents: new Map(useSessionStore.getState().sessions[this.serverId]?.agents),
        subscriptionId: null,
      };
    }
    const { client, source } = onlineConnection;
    // The transaction spans the whole refresh, so a live delta that arrives while the saved
    // baseline or the session is still pending is replayed on top of whatever snapshot lands.
    const transaction = this.agentTransactions.begin(source, () => ({
      entries: [],
      subscriptionId: null,
      legacy: false,
      syncRemovals: [],
    }));
    this.callbacks.markAgentLoading();
    try {
      await this.baseline;
      await this.waitForSession(client, source);
      const session = useSessionStore.getState().sessions[this.serverId];
      if (!input.filter && shouldUseLegacyDaemonWorkspaceDirectory(session?.serverInfo)) {
        const directory = await readLegacyDaemonWorkspaceDirectory({
          client,
          subscribe: input.subscribe,
          page: input.page,
        });
        if (
          !directory ||
          !this.agentTransactions.isCurrent(transaction) ||
          !this.isCurrent(client, source)
        ) {
          throw new DirectoryRefreshSupersededError("legacy fetch no longer current");
        }
        transaction.snapshot.entries.push(...stampLegacyWorkspaceIds(directory.entries));
        transaction.snapshot.subscriptionId = directory.subscriptionId;
        transaction.snapshot.legacy = true;
      } else {
        await this.fetchAgents(client, source, transaction, input);
      }
      if (!this.isCurrent(client, source) || !this.hasMatchingSession(client, source)) {
        throw new DirectoryRefreshSupersededError("agent completion no longer current");
      }
      const completion = this.agentTransactions.complete(transaction);
      if (completion.kind === "stale") {
        throw new DirectoryRefreshSupersededError("agent completion was superseded");
      }
      if (completion.snapshot.legacy) {
        const workspaces = buildLegacyWorkspaces(completion.snapshot.entries);
        const previous = this.readWorkspaceState();
        this.workspaces.commitSnapshot(
          {
            workspaces,
            projects: new Map(
              Array.from(workspaces.values(), legacyProjectDescriptorFromWorkspace).map(
                (project) => [project.projectId, project],
              ),
            ),
          },
          [],
        );
        const next = this.workspaces.snapshot();
        this.persistWorkspaceChanges(
          previous,
          new Set([...previous.workspaces.keys(), ...next.workspaces.keys()]),
          new Set([...previous.projects.keys(), ...next.projects.keys()]),
        );
      }
      const deltas = completion.snapshot.legacy
        ? completion.deltas.map((delta) =>
            delta.kind === "upsert"
              ? { ...delta, agent: { ...delta.agent, workspaceId: delta.agent.cwd } }
              : delta,
          )
        : completion.deltas;
      const agents = this.commitAgentSnapshot(completion.snapshot, deltas);
      this.persistAgentCursors(completion.snapshot);
      this.persistCheckpoint();
      this.callbacks.markAgentReady();
      return { agents, subscriptionId: completion.snapshot.subscriptionId };
    } catch (error) {
      const deltas = this.agentTransactions.fail(transaction);
      if (deltas) for (const delta of deltas) this.agents.applyDelta(delta);
      if (!(error instanceof DirectoryRefreshSupersededError)) {
        this.callbacks.markAgentError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  async refreshWorkspaces(input?: { subscribe?: boolean }): Promise<void> {
    const onlineConnection = this.getOnlineConnection();
    if (!onlineConnection) {
      await this.baseline;
      return;
    }
    const { client, source } = onlineConnection;
    // The transaction spans the whole refresh. Its base for a changes-mode page is the store once
    // the saved baseline is in it, so it is captured after that wait rather than at begin.
    const transaction = this.workspaceTransactions.begin(source, () => ({
      workspaces: new Map(),
      projects: new Map(),
      syncCursors: {},
      syncModes: {},
      touchedWorkspaceIds: new Set(),
      touchedProjectIds: new Set(),
    }));
    try {
      await this.baseline;
      const session = useSessionStore.getState().sessions[this.serverId];
      transaction.snapshot.workspaces = new Map(session?.workspaces);
      transaction.snapshot.projects = new Map(session?.projects);
      await this.waitForSessionMetadata(client, source);
      const serverInfo = useSessionStore.getState().sessions[this.serverId]?.serverInfo;
      if (serverInfo?.features?.workspaceMultiplicity !== true) {
        const deltas = this.workspaceTransactions.fail(transaction);
        if (deltas) for (const delta of deltas) this.applyWorkspaceDelta(delta);
        return;
      }
      const supportsProjectList = serverInfo.features?.projectList === true;
      const supportsDirectorySync = serverInfo.features?.directorySync === true;
      if (supportsProjectList) {
        await this.fetchProjectSnapshot(client, source, transaction, supportsDirectorySync);
      }
      await this.fetchWorkspaceSnapshot(
        client,
        source,
        transaction,
        input?.subscribe === true,
        supportsDirectorySync,
      );
      if (!supportsProjectList) {
        this.buildLegacyProjectSnapshot(transaction.snapshot);
        (transaction.snapshot.syncModes ??= {}).projects =
          transaction.snapshot.syncModes?.workspaces;
      }
      this.completeWorkspaceRefresh(client, source, transaction);
    } catch (error) {
      const deltas = this.workspaceTransactions.fail(transaction);
      if (deltas) for (const delta of deltas) this.applyWorkspaceDelta(delta);
      throw error;
    }
  }

  private async fetchWorkspaceSnapshot(
    client: DaemonClient,
    source: DirectorySourceToken,
    transaction: DirectoryTransaction<WorkspaceDirectorySnapshot, WorkspaceDirectoryDelta>,
    initialSubscribe: boolean,
    supportsDirectorySync: boolean,
  ): Promise<void> {
    let cursor: string | null = null;
    let subscribe = initialSubscribe;
    while (true) {
      const payload = await client.fetchWorkspaces({
        sort: [{ key: "activity_at", direction: "desc" }],
        ...(subscribe ? { subscribe: {} } : {}),
        page: cursor ? { limit: PAGE_LIMIT, cursor } : { limit: PAGE_LIMIT },
        ...(supportsDirectorySync ? { sync: this.readCursors().workspaces ?? {} } : {}),
      });
      this.assertWorkspaceTransactionCurrent(client, source, transaction);
      applyWorkspaceSnapshotPage(transaction.snapshot, payload, cursor === null);
      if (!payload.pageInfo.hasMore || !payload.pageInfo.nextCursor) return;
      cursor = payload.pageInfo.nextCursor;
      subscribe = false;
    }
  }

  private buildLegacyProjectSnapshot(snapshot: WorkspaceDirectorySnapshot): void {
    for (const workspace of snapshot.workspaces.values()) {
      if (!snapshot.projects.has(workspace.projectId)) {
        const project = legacyProjectDescriptorFromWorkspace(workspace);
        snapshot.projects.set(project.projectId, project);
      }
    }
  }

  async refreshAll(): Promise<void> {
    await Promise.all([
      this.refreshAgents({ subscribe: {} }),
      this.refreshWorkspaces({ subscribe: true }),
    ]);
    this.checkpoints?.replaceDirectoryBaseline?.(this.serverId, {
      agents: this.agents.snapshot(),
      ...this.workspaces.snapshot(),
      checkpoint: this.cursors,
    });
    if (this.getOnlineConnection()) await this.connectWorkspaceLabels();
  }

  async connectWorkspaceLabels(): Promise<void> {
    const { client } = this.requireOnline();
    const serverInfo = client.getLastServerInfoMessage();
    await workspaceLabels.connect({
      serverId: this.serverId,
      client,
      supportsWorkspaceLabels: serverInfo?.features?.workspaceLabels === true,
    });
  }

  acceptWorkspaces(workspaces: readonly WorkspaceDescriptor[]): void {
    const mutations = this.workspaces.acceptWorkspaces(workspaces);
    this.checkpoints?.commitDirectoryMutations(this.serverId, mutations);
  }

  archiveAgent(agentId: string, archivedAt: string): void {
    this.agents.archive(agentId, archivedAt);
  }

  removeAgent(agentId: string): void {
    this.agents.remove(agentId);
  }

  acceptProject(project: ProjectDescriptor): void {
    const mutations = this.workspaces.acceptProject(project);
    this.checkpoints?.commitDirectoryMutations(this.serverId, mutations);
  }

  removeWorkspace(workspaceId: string): void {
    const mutations = this.workspaces.removeWorkspaceSnapshot(workspaceId);
    this.checkpoints?.commitDirectoryMutations(this.serverId, mutations);
  }

  markWorkspacesHydrated(hydrated: boolean): void {
    useSessionStore.getState().setHasHydratedWorkspaces(this.serverId, hydrated);
  }

  private async fetchAgents(
    client: DaemonClient,
    source: DirectorySourceToken,
    transaction: DirectoryTransaction<AgentSnapshot, AgentDirectoryDelta>,
    input: RefreshAgentDirectoryInput,
  ): Promise<void> {
    let cursor = input.page?.cursor ?? null;
    let subscribe = input.subscribe;
    while (true) {
      const limit = input.page?.limit ?? PAGE_LIMIT;
      const payload = await client.fetchAgents({
        ...(input.filter ? { filter: input.filter } : { scope: "active" as const }),
        sort: AGENT_SORT,
        ...(subscribe ? { subscribe } : {}),
        page: cursor ? { limit, cursor } : { limit },
        ...(!input.filter && cursor === null && this.supportsDirectorySync()
          ? { sync: this.readCursors().agents ?? {} }
          : {}),
      });
      this.assertAgentTransactionCurrent(client, source, transaction);
      transaction.snapshot.entries.push(...payload.entries);
      transaction.snapshot.subscriptionId ??= payload.subscriptionId ?? null;
      this.recordAgentSync(transaction.snapshot, payload.sync);
      const { hasMore, nextCursor } = resolveAgentNextPage(payload.pageInfo as AgentPageInfo);
      if (!hasMore || !nextCursor) break;
      cursor = nextCursor;
      subscribe = undefined;
    }
  }

  private assertAgentTransactionCurrent(
    client: DaemonClient,
    source: DirectorySourceToken,
    transaction: DirectoryTransaction<AgentSnapshot, AgentDirectoryDelta>,
  ): void {
    if (!this.agentTransactions.isCurrent(transaction) || !this.isCurrent(client, source)) {
      throw new DirectoryRefreshSupersededError("agent page no longer current");
    }
  }

  private assertWorkspaceTransactionCurrent(
    client: DaemonClient,
    source: DirectorySourceToken,
    transaction: DirectoryTransaction<WorkspaceDirectorySnapshot, WorkspaceDirectoryDelta>,
  ): void {
    if (!this.workspaceTransactions.isCurrent(transaction) || !this.isCurrent(client, source)) {
      throw new DirectoryRefreshSupersededError("workspace fetch no longer current");
    }
  }

  private requireOnline(): { client: DaemonClient; source: DirectorySourceToken } {
    const connection = this.getOnlineConnection();
    if (!connection) {
      throw new Error(`Host ${this.serverId} is not connected`);
    }
    return connection;
  }

  private getOnlineConnection(): { client: DaemonClient; source: DirectorySourceToken } | null {
    if (!this.connection.client || this.connection.status !== "online") return null;
    return { client: this.connection.client, source: this.connection.source };
  }

  private supportsDirectorySync(): boolean {
    return (
      useSessionStore.getState().sessions[this.serverId]?.serverInfo?.features?.directorySync ===
      true
    );
  }

  private commitAgentSnapshot(
    snapshot: AgentSnapshot,
    deltas: readonly AgentDirectoryDelta[],
  ): Map<string, Agent> {
    return snapshot.syncMode === "changes"
      ? this.agents.commitChanges(snapshot.entries, snapshot.syncRemovals, deltas)
      : this.agents.commitSnapshot(snapshot.entries, deltas);
  }

  private persistAgentCursors(snapshot: AgentSnapshot): void {
    if (snapshot.syncCursor) this.writeCursor("agents", snapshot.syncCursor);
  }

  private async fetchProjectSnapshot(
    client: DaemonClient,
    source: DirectorySourceToken,
    transaction: DirectoryTransaction<WorkspaceDirectorySnapshot, WorkspaceDirectoryDelta>,
    supportsDirectorySync: boolean,
  ): Promise<void> {
    const payload = await client.listProjects(
      supportsDirectorySync ? { sync: this.readCursors().projects ?? {} } : undefined,
    );
    this.assertWorkspaceTransactionCurrent(client, source, transaction);
    if (payload.sync?.mode !== "changes") transaction.snapshot.projects.clear();
    (transaction.snapshot.syncModes ??= {}).projects = payload.sync?.mode ?? "snapshot";
    for (const entry of payload.projects) {
      const project = normalizeProjectDescriptor(entry);
      transaction.snapshot.projects.set(project.projectId, project);
      (transaction.snapshot.touchedProjectIds ??= new Set()).add(project.projectId);
    }
    for (const removal of payload.sync?.removals ?? []) {
      transaction.snapshot.projects.delete(removal.id);
      (transaction.snapshot.touchedProjectIds ??= new Set()).add(removal.id);
    }
    if (payload.sync) {
      (transaction.snapshot.syncCursors ??= {}).projects = {
        generation: payload.sync.generation,
        afterSeq: payload.sync.headSeq,
      };
    }
  }

  private completeWorkspaceRefresh(
    client: DaemonClient,
    source: DirectorySourceToken,
    transaction: DirectoryTransaction<WorkspaceDirectorySnapshot, WorkspaceDirectoryDelta>,
  ): void {
    if (!this.isCurrent(client, source) || !this.hasMatchingSession(client, source)) {
      throw new DirectoryRefreshSupersededError("workspace completion no longer current");
    }
    const completion = this.workspaceTransactions.complete(transaction);
    if (completion.kind === "stale") {
      throw new DirectoryRefreshSupersededError("workspace completion was superseded");
    }
    const previous = this.readWorkspaceState();
    const deltaMutations = this.workspaces.commitSnapshot(completion.snapshot, completion.deltas);
    const next = this.workspaces.snapshot();
    const workspaceIds =
      completion.snapshot.syncModes?.workspaces === "changes"
        ? new Set(completion.snapshot.touchedWorkspaceIds)
        : new Set([...previous.workspaces.keys(), ...next.workspaces.keys()]);
    const projectIds =
      completion.snapshot.syncModes?.projects === "changes"
        ? new Set(completion.snapshot.touchedProjectIds)
        : new Set([...previous.projects.keys(), ...next.projects.keys()]);
    for (const mutation of deltaMutations) {
      if (mutation.kind === "workspace") workspaceIds.add(mutation.id);
      if (mutation.kind === "project") projectIds.add(mutation.id);
    }
    this.persistWorkspaceChanges(previous, workspaceIds, projectIds);
    for (const [entity, cursor] of Object.entries(completion.snapshot.syncCursors ?? {})) {
      if (cursor) this.writeCursor(entity as "projects" | "workspaces", cursor);
    }
    this.persistCheckpoint();
  }

  // Only a completed catch-up may advance the saved cursor. A live sequence can follow an offline
  // gap, so saving it would claim intermediate changes the client never received.
  private persistCheckpoint(): void {
    this.checkpoints?.commitDirectoryMutations(this.serverId, [], this.cursors);
  }

  private readWorkspaceState(): WorkspaceDirectorySnapshot {
    return this.workspaces.snapshot();
  }

  private applyWorkspaceDelta(delta: WorkspaceDirectoryDelta): void {
    const mutations = this.workspaces.applyDelta(delta);
    this.checkpoints?.commitDirectoryMutations(this.serverId, mutations);
  }

  private persistWorkspaceChanges(
    previous: WorkspaceDirectorySnapshot,
    workspaceIds: Set<string>,
    projectIds: Set<string>,
  ): void {
    const next = this.workspaces.snapshot();
    const mutations: DirectoryReplicaMutation[] = [];
    for (const id of workspaceIds) {
      const value = next.workspaces.get(id);
      if (value) mutations.push({ kind: "workspace", type: "upsert", id, value });
      else if (previous.workspaces.has(id))
        mutations.push({ kind: "workspace", type: "delete", id });
    }
    for (const id of projectIds) {
      const value = next.projects.get(id);
      if (value) mutations.push({ kind: "project", type: "upsert", id, value });
      else if (previous.projects.has(id)) mutations.push({ kind: "project", type: "delete", id });
    }
    this.checkpoints?.commitDirectoryMutations(this.serverId, mutations);
  }

  private recordAgentSync(
    snapshot: AgentSnapshot,
    sync: Awaited<ReturnType<DaemonClient["fetchAgents"]>>["sync"],
  ): void {
    if (!sync) return;
    snapshot.syncMode = sync.mode;
    snapshot.syncRemovals.push(...sync.removals);
    snapshot.syncCursor = { generation: sync.generation, afterSeq: sync.headSeq };
  }

  private readCursors(): DirectoryCheckpoint {
    return this.cursors;
  }

  private writeCursor(
    entity: keyof DirectoryCheckpoint,
    cursor: { generation: string; afterSeq: number },
  ): void {
    const current = this.readCursors();
    const previous = current[entity];
    if (previous?.generation === cursor.generation && previous.afterSeq >= cursor.afterSeq) return;
    this.cursors = { ...current, [entity]: cursor };
  }

  private isCurrent(client: DaemonClient, source: DirectorySourceToken): boolean {
    return (
      this.connection.client === client &&
      this.connection.status === "online" &&
      this.connection.source.clientGeneration === source.clientGeneration &&
      this.connection.source.connectionEpoch === source.connectionEpoch
    );
  }

  private async waitForSession(client: DaemonClient, source: DirectorySourceToken): Promise<void> {
    await this.waitForSessionState(client, source, () => this.hasMatchingSession(client, source));
  }

  private async waitForSessionMetadata(
    client: DaemonClient,
    source: DirectorySourceToken,
  ): Promise<void> {
    await this.waitForSessionState(client, source, () => {
      const session = useSessionStore.getState().sessions[this.serverId];
      return this.hasMatchingSession(client, source) && session?.serverInfo !== null;
    });
  }

  private async waitForSessionState(
    client: DaemonClient,
    source: DirectorySourceToken,
    matches: () => boolean,
  ): Promise<void> {
    if (matches()) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribe: () => void = () => undefined;
      const finish = (result: "ready" | "aborted") => {
        if (settled) return;
        settled = true;
        unsubscribe();
        this.abortSessionWaits.delete(abort);
        if (result === "ready") resolve();
        else reject(new DirectoryRefreshSupersededError("session wait no longer current"));
      };
      const abort = () => finish("aborted");
      const check = () => {
        if (matches()) {
          finish("ready");
        } else if (!this.isCurrent(client, source)) {
          finish("aborted");
        }
      };
      this.abortSessionWaits.add(abort);
      unsubscribe = useSessionStore.subscribe(check);
      check();
    });
  }

  private hasMatchingSession(client: DaemonClient, source: DirectorySourceToken): boolean {
    const session = useSessionStore.getState().sessions[this.serverId];
    return session?.client === client && session.clientGeneration === source.clientGeneration;
  }

  private flushAbortedTransactions(): void {
    for (const delta of this.agentTransactions.abort()) this.agents.applyDelta(delta);
    for (const delta of this.workspaceTransactions.abort()) this.applyWorkspaceDelta(delta);
  }

  private abortPendingSessionWaits(): void {
    for (const abort of this.abortSessionWaits) abort();
  }
}

function legacyProjectDescriptorFromWorkspace(workspace: WorkspaceDescriptor): ProjectDescriptor {
  return {
    projectId: workspace.projectId,
    projectKey: null,
    projectDisplayName: workspace.projectDisplayName,
    projectCustomName: workspace.projectCustomName ?? null,
    projectRootPath: workspace.projectRootPath,
    projectKind: workspace.projectKind,
  };
}

export class DirectoryRefreshSupersededError extends Error {}

export type { DirectorySourceToken } from "./transaction";
