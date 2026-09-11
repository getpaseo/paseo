import type { OwnedSubscription } from "@getpaseo/client";
import type {
  DaemonClient,
  FetchAgentsEntry,
  FetchAgentsOptions,
} from "@getpaseo/client/internal/daemon-client";
import { fetchAgentTimelineOnce } from "@/timeline/fetch-agent-timeline-once";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type Agent,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import type { AgentDirectoryDelta } from "@/utils/agent-directory-sync";
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
  CachedWorkspace,
  DirectoryCheckpoint,
  DirectoryCursor,
  DirectoryReplicaMutation,
} from "@/runtime/replica-cache";
import type { TurnLivenessTransition } from "@/timeline/turn-liveness";

type FetchAgentsPayload = Awaited<ReturnType<DaemonClient["fetchAgents"]>>;
type FetchWorkspacesPayload = Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>;

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
  readAgent(serverId: string, agentId: string): Promise<Agent | undefined>;
  readWorkspace(serverId: string, workspaceId: string): Promise<CachedWorkspace | undefined>;
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
  private readonly agents: AgentDirectoryReplica;
  private readonly workspaces: WorkspaceDirectoryReplica;
  private connection: DirectoryConnection = {
    client: null,
    status: "offline",
    source: { clientGeneration: 0, connectionEpoch: 0 },
  };
  private agentSubscription: OwnedSubscription<FetchAgentsPayload> | null = null;
  private workspaceSubscription: OwnedSubscription<FetchWorkspacesPayload> | null = null;
  private eventSubscription: ReturnType<DaemonClient["observeEvents"]> | null = null;
  private readonly abortSessionWaits = new Set<() => void>();
  private cacheLoad: Promise<void> | null = null;
  private cacheAccepted = false;
  private revision = 0;
  private workspaceRevision = 0;
  private readonly routeDemandIds = new Set<string>();
  private readonly fullDemandSources = new Set<object>();
  private demandRefresh: Promise<void> | null = null;
  private satisfiedDemandSource: DirectorySourceToken | null = null;
  private cursors: DirectoryCheckpoint = {};

  constructor(
    private readonly serverId: string,
    private readonly callbacks: {
      onAgentStoppedRunning: (agentId: string) => void;
      markAgentLoading: () => void;
      markAgentReady: () => void;
      markAgentError: (error: string) => void;
    },
    private readonly checkpoints?: DirectoryCheckpointStorage,
  ) {
    const persist = (mutations: readonly DirectoryReplicaMutation[]) =>
      this.checkpoints?.commitDirectoryMutations(this.serverId, mutations);
    this.agents = new AgentDirectoryReplica(serverId, callbacks.onAgentStoppedRunning, persist);
    this.workspaces = new WorkspaceDirectoryReplica(serverId);
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
    this.releaseSubscriptions();
    workspaceLabels.disconnect(this.serverId);
    this.connection = connection;
    this.abortPendingSessionWaits();
    if (!connection.client || connection.status !== "online") return true;
    if (this.hasDemand()) void this.requestDemandRefresh().catch(() => undefined);
    return true;
  }

  setDemand(source: object, demanded: boolean): void {
    const wasDemanded = this.fullDemandSources.size > 0;
    if (demanded) this.fullDemandSources.add(source);
    else this.fullDemandSources.delete(source);
    if (!this.hasDemand()) this.releaseSubscriptions();
    if (!wasDemanded && this.fullDemandSources.size > 0) {
      void this.loadCachedDirectory().catch(() => undefined);
      if (this.getOnlineConnection()) void this.requestDemandRefresh().catch(() => undefined);
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
    if (!this.hasDemand()) this.releaseSubscriptions();
    if (this.routeDemandIds.size > 0 && this.getOnlineConnection()) {
      void this.requestDemandRefresh().catch(() => undefined);
    }
  }

  dispose(): void {
    this.flushAbortedTransactions();
    this.abortPendingSessionWaits();
    this.releaseSubscriptions();
    this.fullDemandSources.clear();
    this.routeDemandIds.clear();
    workspaceLabels.disconnect(this.serverId);
  }

  private releaseSubscriptions(): void {
    for (const subscription of [
      this.agentSubscription,
      this.workspaceSubscription,
      this.eventSubscription,
    ]) {
      void subscription?.release().catch(() => undefined);
    }
    this.agentSubscription = null;
    this.workspaceSubscription = null;
    this.eventSubscription = null;
    this.satisfiedDemandSource = null;
  }

  private receiveAgentDelta(source: DirectorySourceToken, delta: AgentDirectoryDelta): void {
    this.revision += 1;
    if (this.agentTransactions.record(source, delta)) return;
    this.agents.applyDelta(delta);
    this.noteLiveCursor("agents", delta);
    this.persistCheckpoint();
  }

  private receiveWorkspaceDelta(
    source: DirectorySourceToken,
    delta: WorkspaceDirectoryDelta,
  ): void {
    this.revision += 1;
    this.workspaceRevision += 1;
    if (this.workspaceTransactions.record(source, delta)) return;
    this.applyWorkspaceDelta(delta);
    if (delta.kind !== "script_status")
      this.noteLiveCursor(
        "projectId" in delta || "project" in delta ? "projects" : "workspaces",
        delta,
      );
    this.persistCheckpoint();
  }

  private observeDirectoryEvents(): void {
    if (this.eventSubscription) return;
    const { client, source } = this.requireOnline();
    this.eventSubscription = client.observeEvents(["project.update", "script_status_update"]);
    this.eventSubscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (!this.isCurrent(client, source)) return;
        if (message.type === "project.update") this.receiveWorkspaceDelta(source, message.payload);
        if (message.type === "script_status_update")
          this.receiveWorkspaceDelta(source, { kind: "script_status", update: message.payload });
      },
    });
  }

  private hasDemand(): boolean {
    return this.fullDemandSources.size > 0 || this.routeDemandIds.size > 0;
  }

  private requestDemandRefresh(force = false): Promise<void> {
    if (this.demandRefresh) return this.demandRefresh;
    if (!this.hasDemand()) return Promise.resolve();
    if (!this.getOnlineConnection()) {
      return this.fullDemandSources.size > 0 ? this.loadCachedDirectory() : Promise.resolve();
    }
    this.observeDirectoryEvents();
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
            this.refreshAgentsInternal({ subscribe: {} }, false),
            this.refreshWorkspacesInternal({ subscribe: true }, false),
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

  async loadCachedAgent(agentId: string): Promise<void> {
    if (!this.checkpoints) return;
    if (useSessionStore.getState().sessions[this.serverId]?.agents.has(agentId)) return;
    const token = this.agents.captureCache(agentId);
    const agent = await this.checkpoints.readAgent(this.serverId, agentId);
    if (!agent) return;
    const session = useSessionStore.getState().sessions[this.serverId];
    if (!session || session.agents.has(agentId)) return;
    this.agents.commitCachedAgent(token, agent);
  }

  async prepareAgentRoute(agentId: string): Promise<void> {
    await this.loadCachedAgent(agentId);
    const agent = useSessionStore.getState().sessions[this.serverId]?.agents.get(agentId);
    if (agent?.workspaceId) await this.loadCachedWorkspace(agent.workspaceId);
  }

  async prepareWorkspaceRoute(workspaceId: string): Promise<void> {
    await this.loadCachedWorkspace(workspaceId);
  }

  private async loadCachedWorkspace(workspaceId: string): Promise<void> {
    if (!this.checkpoints) return;
    if (useSessionStore.getState().sessions[this.serverId]?.workspaces.has(workspaceId)) return;
    const revision = this.workspaceRevision;
    const cached = await this.checkpoints.readWorkspace(this.serverId, workspaceId);
    if (!cached) return;
    if (this.workspaceRevision !== revision) return;
    const session = useSessionStore.getState().sessions[this.serverId];
    if (!session) return;
    this.workspaces.commitCachedWorkspace(cached.workspace, cached.project);
  }

  private loadCachedDirectory(): Promise<void> {
    const checkpoints = this.checkpoints;
    if (!checkpoints) return Promise.resolve();
    this.cacheLoad ??= (async () => {
      const revision = this.revision;
      const cached = await checkpoints.readDirectory(this.serverId);
      if (this.cacheAccepted) return;
      if (!useSessionStore.getState().sessions[this.serverId]) return;
      this.agents.commitCached(cached.agents);
      this.workspaces.commitCached(cached);
      if (this.revision === revision) this.cursors = cached.checkpoint ?? {};
      this.cacheAccepted = true;
    })();
    return this.cacheLoad;
  }

  restoreCachedDirectory(): Promise<void> {
    return this.loadCachedDirectory();
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
  ): Promise<Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>> {
    const { client } = this.requireOnline();
    const token = this.agents.captureTimeline(agentId);
    const page = await fetchAgentTimelineOnce(client, agentId, request);
    if (page.agent && this.agents.submitTimelineAgent(token, page.agent)) {
      this.revision += 1;
      this.persistCheckpoint();
    }
    return page;
  }

  async refreshAgents(
    input: RefreshAgentDirectoryInput = {},
  ): Promise<RefreshAgentDirectoryResult> {
    return this.refreshAgentsInternal(input, true);
  }

  private async refreshAgentsInternal(
    input: RefreshAgentDirectoryInput,
    loadDirectoryCache: boolean,
  ): Promise<RefreshAgentDirectoryResult> {
    if (loadDirectoryCache) {
      this.primeAgentTransactionForCacheLoad();
      await this.loadCachedDirectory();
    }
    const onlineConnection = this.getOnlineConnection();
    if (!onlineConnection) {
      this.callbacks.markAgentReady();
      return {
        agents: new Map(useSessionStore.getState().sessions[this.serverId]?.agents),
        subscriptionId: null,
      };
    }
    const { client, source } = onlineConnection;
    const transaction = this.agentTransactions.begin(source, () => ({
      entries: [],
      subscriptionId: null,
      syncRemovals: [],
    }));
    this.callbacks.markAgentLoading();
    try {
      await this.waitForSession(client, source);
      await this.fetchAgents(client, source, transaction, input);
      if (!this.isCurrent(client, source) || !this.hasMatchingSession(client, source)) {
        throw new DirectoryRefreshSupersededError("agent completion no longer current");
      }
      const completion = this.agentTransactions.complete(transaction);
      if (completion.kind === "stale") {
        throw new DirectoryRefreshSupersededError("agent completion was superseded");
      }
      this.revision += 1;
      const agents = this.commitAgentSnapshot(completion.snapshot, completion.deltas);
      this.persistAgentCursors(completion.snapshot, completion.deltas);
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
    return this.refreshWorkspacesInternal(input, true);
  }

  private async refreshWorkspacesInternal(
    input: { subscribe?: boolean } | undefined,
    loadDirectoryCache: boolean,
  ): Promise<void> {
    if (loadDirectoryCache) await this.loadCachedDirectory();
    const onlineConnection = this.getOnlineConnection();
    if (!onlineConnection) return;
    const { client, source } = onlineConnection;
    const transaction = this.workspaceTransactions.begin(source, () => ({
      workspaces: new Map(useSessionStore.getState().sessions[this.serverId]?.workspaces),
      projects: new Map(useSessionStore.getState().sessions[this.serverId]?.projects),
      syncCursors: {},
      syncModes: {},
      touchedWorkspaceIds: new Set(),
      touchedProjectIds: new Set(),
    }));
    try {
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
      const query: Parameters<DaemonClient["observeWorkspaces"]>[0] = {
        sort: [{ key: "activity_at", direction: "desc" }],
        page: cursor ? { limit: PAGE_LIMIT, cursor } : { limit: PAGE_LIMIT },
        ...(supportsDirectorySync ? { sync: this.readCursors().workspaces ?? {} } : {}),
      };
      let payload: FetchWorkspacesPayload;
      if (subscribe) {
        void this.workspaceSubscription?.release().catch(() => undefined);
        const subscription = client.observeWorkspaces(query);
        this.workspaceSubscription = subscription;
        subscription.subscribe({
          snapshot: () => {},
          update: (message) => {
            if (message.type === "workspace_update" && this.isCurrent(client, source))
              this.receiveWorkspaceDelta(source, message.payload);
          },
        });
        payload = await subscription.ready;
      } else payload = await client.fetchWorkspaces(query);
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
      const query: Omit<FetchAgentsOptions, "subscribe"> = {
        ...(input.filter ? { filter: input.filter } : { scope: "active" as const }),
        sort: AGENT_SORT,
        page: cursor ? { limit, cursor } : { limit },
        ...(!input.filter && cursor === null && this.supportsDirectorySync()
          ? { sync: this.readCursors().agents ?? {} }
          : {}),
      };
      let payload: FetchAgentsPayload;
      if (subscribe) {
        if (subscribe.subscriptionId) throw new Error("Subscription IDs are assigned by the host");
        void this.agentSubscription?.release().catch(() => undefined);
        const subscription = client.observeAgents(query);
        this.agentSubscription = subscription;
        subscription.subscribe({
          snapshot: () => {},
          update: (message) => {
            if (message.type === "agent_update" && this.isCurrent(client, source))
              this.receiveAgentDelta(source, message.payload);
          },
        });
        payload = await subscription.ready;
      } else payload = await client.fetchAgents(query);
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

  private primeAgentTransactionForCacheLoad(): void {
    const connection = this.getOnlineConnection();
    if (!connection) return;
    this.agentTransactions.begin(connection.source, () => ({
      entries: [],
      subscriptionId: null,
      syncRemovals: [],
    }));
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

  private persistAgentCursors(
    snapshot: AgentSnapshot,
    deltas: readonly AgentDirectoryDelta[],
  ): void {
    if (snapshot.syncCursor) this.writeCursor("agents", snapshot.syncCursor);
    for (const delta of deltas) this.noteLiveCursor("agents", delta);
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
    this.revision += 1;
    this.workspaceRevision += 1;
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
    for (const delta of completion.deltas) {
      if (delta.kind === "script_status") continue;
      const entity = "projectId" in delta || "project" in delta ? "projects" : "workspaces";
      this.noteLiveCursor(entity, delta);
    }
    this.persistCheckpoint();
  }

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

  private noteLiveCursor(
    entity: keyof DirectoryCheckpoint,
    payload: { generation?: string; seq?: number },
  ): void {
    if (!payload.generation || payload.seq === undefined) return;
    this.writeCursor(entity, {
      generation: payload.generation,
      afterSeq: payload.seq,
    });
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
