import type {
  DaemonClient,
  FetchAgentsEntry,
  FetchAgentsOptions,
} from "@getpaseo/client/internal/daemon-client";
import { fetchAgentTimelineOnce } from "@/timeline/fetch-agent-timeline-once";
import {
  normalizeEmptyProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type Agent,
} from "@/stores/session-store";
import {
  readLegacyDaemonWorkspaceDirectory,
  buildLegacyWorkspaces,
  shouldUseLegacyDaemonWorkspaceDirectory,
  stampLegacyWorkspaceIds,
} from "@/workspace/legacy-daemon-workspaces";
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

const PAGE_LIMIT = 200;
const AGENT_SORT: NonNullable<FetchAgentsOptions["sort"]> = [
  { key: "updated_at", direction: "desc" },
];

interface AgentSnapshot {
  entries: FetchAgentsEntry[];
  subscriptionId: string | null;
  legacy: boolean;
}

export interface DirectoryConnection {
  client: DaemonClient | null;
  status: "online" | "offline";
  source: DirectorySourceToken;
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
  private unsubscribe: (() => void) | null = null;
  private readonly abortSessionWaits = new Set<() => void>();

  constructor(
    private readonly serverId: string,
    private readonly callbacks: {
      drainQueuedAgentMessage: (agentId: string) => void;
      markAgentLoading: () => void;
      markAgentReady: () => void;
      markAgentError: (error: string) => void;
    },
  ) {
    this.agents = new AgentDirectoryReplica(serverId, callbacks.drainQueuedAgentMessage);
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
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.connection = connection;
    this.abortPendingSessionWaits();
    if (!connection.client || connection.status !== "online") return true;
    const client = connection.client;
    const source = connection.source;
    this.workspaceTransactions.begin(source, () => ({
      workspaces: new Map(),
      emptyProjects: new Map(),
    }));
    const subscriptions = [
      client.on("agent_update", (message) => {
        if (message.type !== "agent_update" || !this.isCurrent(client, source)) return;
        if (!this.agentTransactions.record(source, message.payload))
          this.agents.applyDelta(message.payload);
      }),
      client.on("workspace_update", (message) => {
        if (message.type !== "workspace_update" || !this.isCurrent(client, source)) return;
        if (!this.workspaceTransactions.record(source, message.payload)) {
          this.workspaces.applyDelta(message.payload);
        }
      }),
      client.on("project.update", (message) => {
        if (message.type !== "project.update" || !this.isCurrent(client, source)) return;
        if (!this.workspaceTransactions.record(source, message.payload)) {
          this.workspaces.applyDelta(message.payload);
        }
      }),
      client.on("agent_deleted", (message) => {
        if (message.type === "agent_deleted" && this.isCurrent(client, source)) {
          this.agents.remove(message.payload.agentId);
        }
      }),
      client.on("agent_archived", (message) => {
        if (message.type === "agent_archived" && this.isCurrent(client, source)) {
          this.agents.archive(message.payload.agentId, message.payload.archivedAt);
        }
      }),
    ];
    this.unsubscribe = () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
    return true;
  }

  dispose(): void {
    this.flushAbortedTransactions();
    this.abortPendingSessionWaits();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async fetchTimeline(
    agentId: string,
    request: Parameters<DaemonClient["fetchAgentTimeline"]>[1],
  ): Promise<Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>> {
    const { client } = this.requireOnline();
    const token = this.agents.captureTimeline(agentId);
    const page = await fetchAgentTimelineOnce(client, agentId, request);
    if (page.agent) this.agents.submitTimelineAgent(token, page.agent);
    return page;
  }

  async refreshAgents(
    input: RefreshAgentDirectoryInput = {},
  ): Promise<RefreshAgentDirectoryResult> {
    const { client, source } = this.requireOnline();
    const transaction = this.agentTransactions.begin(source, () => ({
      entries: [],
      subscriptionId: null,
      legacy: false,
    }));
    this.callbacks.markAgentLoading();
    try {
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
        const store = useSessionStore.getState();
        store.setWorkspaces(this.serverId, buildLegacyWorkspaces(completion.snapshot.entries));
        store.setEmptyProjects(this.serverId, []);
        store.setHasHydratedWorkspaces(this.serverId, true);
      }
      const deltas = completion.snapshot.legacy
        ? completion.deltas.map((delta) =>
            delta.kind === "upsert"
              ? { ...delta, agent: { ...delta.agent, workspaceId: delta.agent.cwd } }
              : delta,
          )
        : completion.deltas;
      const agents = this.agents.commitSnapshot(completion.snapshot.entries, deltas);
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
    const { client, source } = this.requireOnline();
    const transaction = this.workspaceTransactions.begin(source, () => ({
      workspaces: new Map(),
      emptyProjects: new Map(),
    }));
    try {
      await this.waitForSessionMetadata(client, source);
      const serverInfo = useSessionStore.getState().sessions[this.serverId]?.serverInfo;
      if (serverInfo?.features?.workspaceMultiplicity !== true) {
        const deltas = this.workspaceTransactions.fail(transaction);
        if (deltas) for (const delta of deltas) this.workspaces.applyDelta(delta);
        return;
      }
      await this.fetchWorkspaceSnapshot(client, source, transaction, input?.subscribe === true);
      if (!this.isCurrent(client, source) || !this.hasMatchingSession(client, source)) {
        throw new DirectoryRefreshSupersededError("workspace completion no longer current");
      }
      const completion = this.workspaceTransactions.complete(transaction);
      if (completion.kind === "stale") {
        throw new DirectoryRefreshSupersededError("workspace completion was superseded");
      }
      this.workspaces.commitSnapshot(completion.snapshot, completion.deltas);
    } catch (error) {
      const deltas = this.workspaceTransactions.fail(transaction);
      if (deltas) for (const delta of deltas) this.workspaces.applyDelta(delta);
      throw error;
    }
  }

  private async fetchWorkspaceSnapshot(
    client: DaemonClient,
    source: DirectorySourceToken,
    transaction: DirectoryTransaction<WorkspaceDirectorySnapshot, WorkspaceDirectoryDelta>,
    initialSubscribe: boolean,
  ): Promise<void> {
    let cursor: string | null = null;
    let subscribe = initialSubscribe;
    while (true) {
      const payload = await client.fetchWorkspaces({
        sort: [{ key: "activity_at", direction: "desc" }],
        ...(subscribe ? { subscribe: {} } : {}),
        page: cursor ? { limit: PAGE_LIMIT, cursor } : { limit: PAGE_LIMIT },
      });
      this.assertWorkspaceTransactionCurrent(client, source, transaction);
      for (const entry of payload.entries) {
        const workspace = normalizeWorkspaceDescriptor(entry);
        transaction.snapshot.workspaces.set(workspace.id, workspace);
      }
      for (const entry of payload.emptyProjects ?? []) {
        const project = normalizeEmptyProjectDescriptor(entry);
        transaction.snapshot.emptyProjects.set(project.projectId, project);
      }
      if (!payload.pageInfo.hasMore || !payload.pageInfo.nextCursor) return;
      cursor = payload.pageInfo.nextCursor;
      subscribe = false;
    }
  }

  async refreshAll(): Promise<void> {
    await Promise.all([this.refreshAgents(), this.refreshWorkspaces({ subscribe: true })]);
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
      });
      this.assertAgentTransactionCurrent(client, source, transaction);
      transaction.snapshot.entries.push(...payload.entries);
      transaction.snapshot.subscriptionId ??= payload.subscriptionId ?? null;
      const pageInfo = payload.pageInfo as {
        hasMore?: boolean;
        hasMoreAfter?: boolean;
        nextCursor?: string | null;
        afterCursor?: string | null;
      };
      const hasMore = pageInfo.hasMore ?? pageInfo.hasMoreAfter ?? false;
      const nextCursor = pageInfo.nextCursor ?? pageInfo.afterCursor ?? null;
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
    if (!this.connection.client || this.connection.status !== "online") {
      throw new Error(`Host ${this.serverId} is not connected`);
    }
    return { client: this.connection.client, source: this.connection.source };
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
    for (const delta of this.workspaceTransactions.abort()) this.workspaces.applyDelta(delta);
  }

  private abortPendingSessionWaits(): void {
    for (const abort of this.abortSessionWaits) abort();
  }
}

export class DirectoryRefreshSupersededError extends Error {}

export type { DirectorySourceToken } from "./transaction";
