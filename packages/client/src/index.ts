import type { OwnedSubscription } from "./connection/index.js";
export type { OwnedSubscription, SubscriptionObserver } from "./connection/index.js";
import type { DaemonClientConfig } from "./daemon-client.js";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type {
  AgentSnapshotPayload,
  CreateAgentRequestMessage,
  FetchWorkspacesRequestMessage,
  FetchWorkspacesResponseMessage,
  GetProvidersSnapshotResponseMessage,
  ListAvailableProvidersResponse,
  ListCommandsResponse,
  ListProviderFeaturesRequestMessage,
  ListProviderFeaturesResponseMessage,
  ListProviderModelsResponseMessage,
  ProjectListRequestMessage,
  ProjectListResponseMessage,
  ListProviderModesResponseMessage,
  MutableDaemonConfig,
  MutableDaemonConfigPatch,
  ProviderDiagnosticResponseMessage,
  ProviderUsageListResponseMessage,
  ProjectPlacementPayload,
  WorkspaceProjectDescriptorPayload,
  RefreshProvidersSnapshotResponseMessage,
  SendAgentMessageRequest,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
  WorkspaceCreateRequest,
} from "@getpaseo/protocol/messages";
import { DaemonClient } from "./daemon-client.js";
import {
  createTerminalActions,
  type PaseoTerminalActions,
  type PaseoWorkspaceTerminalActions,
} from "./terminals/index.js";
export type {
  PaseoTerminal,
  PaseoTerminalActions,
  PaseoTerminalHandle,
  PaseoTerminalCreateOptions,
  PaseoTerminalListOptions,
  PaseoTerminalListResult,
  PaseoTerminalCaptureOptions,
  PaseoTerminalCaptureResult,
  PaseoWorkspaceTerminalActions,
} from "./terminals/index.js";
import type { PluginTimelineItem } from "@getpaseo/protocol/agent-types";
import type {
  FetchAgentsEntry,
  FetchAgentsOptions,
  FetchAgentsPageInfo,
  FetchAgentTimelineCursor,
  FetchAgentTimelineDirection,
  FetchAgentTimelinePayload,
  FetchAgentTimelineProjection,
  WaitForFinishResult,
} from "./daemon-client.js";

/**
 * Coding turns routinely run for minutes, so the handle waits far longer than
 * the transport's own conservative default.
 */
const DEFAULT_WAIT_FOR_FINISH_MS = 10 * 60_000;

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; attempt: number }
  | { status: "connected" }
  | { status: "disconnected"; reason?: string }
  | { status: "disposed" };

export interface PaseoLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface PaseoClientConfig {
  capabilities?: DaemonClientConfig["capabilities"];
  url: string;
  clientId?: string;
  appVersion?: string;
  runtimeGeneration?: number | null;
  password?: string;
  authHeader?: string;
  suppressSendErrors?: boolean;
  logger?: PaseoLogger;
  connectTimeoutMs?: number;
  e2ee?: {
    enabled?: boolean;
    daemonPublicKeyB64?: string;
  };
  reconnect?: {
    enabled?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  runtimeMetricsIntervalMs?: number;
  runtimeMetricsWindowMs?: number;
}

export type PaseoWorkspace = WorkspaceDescriptorPayload;
export type PaseoAgent = AgentSnapshotPayload;
export type PaseoAgentListOptions = FetchAgentsOptions;
export type PaseoProject = WorkspaceProjectDescriptorPayload;
export type PaseoProjectListOptions = Omit<ProjectListRequestMessage, "type" | "requestId"> & {
  requestId?: string;
};
export type PaseoProjectListResult = ProjectListResponseMessage["payload"];
export type PaseoProjectUpdate = Extract<
  SessionOutboundMessage,
  { type: "project.update" }
>["payload"];
export type PaseoProjectUpdateHandler = (update: PaseoProjectUpdate) => void;

export interface PaseoAgentListResult {
  subscription?: OwnedSubscription<PaseoAgentListResult>;
  requestId: string;
  subscriptionId?: string | null;
  entries: FetchAgentsEntry[];
  pageInfo: FetchAgentsPageInfo;
}
export type PaseoWorkspaceListOptions = Omit<
  FetchWorkspacesRequestMessage,
  "type" | "requestId"
> & {
  requestId?: string;
};

export interface PaseoWorkspaceListResult {
  subscription?: OwnedSubscription<PaseoWorkspaceListResult>;
  requestId: string;
  subscriptionId?: string | null;
  entries: PaseoWorkspace[];
  pageInfo: FetchWorkspacesResponseMessage["payload"]["pageInfo"];
}

export interface PaseoWorkspaceOpenOptions {
  cwd: string;
  requestId?: string;
}

export type PaseoWorkspaceCreateOptions = Omit<WorkspaceCreateRequest, "type" | "requestId"> & {
  requestId?: string;
};

export interface PaseoWorkspaceArchiveResult {
  requestId: string;
  workspaceId: string;
  archivedAt: string | null;
  error: string | null;
}

export type PaseoWorkspaceUpdate = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];

export type PaseoWorkspaceUpdateHandler = (update: PaseoWorkspaceUpdate) => void;

export interface PaseoWorkspaceHandle {
  readonly id: string;
  readonly projectId: string | null;
  readonly directory: string | null;
  readonly name: string | null;
  readonly status: PaseoWorkspace["status"] | null;
  readonly agents: {
    create(options: PaseoWorkspaceAgentCreateOptions): Promise<PaseoAgentHandle>;
  };
  readonly terminals: PaseoWorkspaceTerminalActions;
  current(): PaseoWorkspace | null;
  refresh(options?: { requestId?: string }): Promise<PaseoWorkspace | null>;
  setTitle(title: string | null, requestId?: string): Promise<{ title: string | null }>;
  archive(requestId?: string): Promise<PaseoWorkspaceArchiveResult>;
  /**
   * Subscribes to already-emitted daemon workspace_update events for this id.
   * This returns a local unsubscribe function; it does not own app cache state or
   * send a daemon unsubscribe RPC. Call `workspaces.list({ subscribe: {} })` when
   * the daemon should start streaming workspace directory updates.
   */
  subscribe(handler: (update: PaseoWorkspaceUpdate) => void): () => void;
}

export interface PaseoProjectActions {
  list(options?: PaseoProjectListOptions): Promise<PaseoProjectListResult>;
  subscribe(handler: PaseoProjectUpdateHandler): () => void;
}

export interface PaseoWorkspaceActions {
  list(options: PaseoWorkspaceListOptions & { subscribe: {} }): Promise<
    PaseoWorkspaceListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<PaseoWorkspaceListResult>;
    }
  >;
  list(options?: PaseoWorkspaceListOptions): Promise<PaseoWorkspaceListResult>;
  ref(workspace: string | PaseoWorkspace): PaseoWorkspaceHandle;
  open(
    input: string | PaseoWorkspaceOpenOptions,
    requestId?: string,
  ): Promise<PaseoWorkspaceHandle>;
  create(options: PaseoWorkspaceCreateOptions): Promise<PaseoWorkspaceHandle>;
  archive(
    workspace: string | PaseoWorkspaceHandle,
    requestId?: string,
  ): Promise<PaseoWorkspaceArchiveResult>;
  /**
   * Local event subscription over the low-level driver's workspace_update stream.
   * The returned function only removes this SDK listener.
   */
  subscribe(handler: PaseoWorkspaceUpdateHandler): () => void;
}

type PaseoAgentSessionConfig = CreateAgentRequestMessage["config"];
export type PaseoAgentProvider = PaseoAgentSessionConfig["provider"];

export type PaseoProviderFeatureValues = Record<string, unknown>;

export interface PaseoAgentConfig {
  /** Provider and model in `provider/model` format. */
  provider: string;
  modeId?: PaseoAgentSessionConfig["modeId"];
  thinkingOptionId?: PaseoAgentSessionConfig["thinkingOptionId"];
  featureValues?: PaseoProviderFeatureValues;
  /** JSON-safe provider-native settings, validated by the selected provider. */
  options?: PaseoAgentSessionConfig["providerOptions"];
  systemPrompt?: PaseoAgentSessionConfig["systemPrompt"];
  toolPolicy?: PaseoAgentSessionConfig["toolPolicy"];
  mcpServers?: PaseoAgentSessionConfig["mcpServers"];
}

export interface PaseoAgentCreateOptions {
  config: PaseoAgentConfig;
  cwd: string;
  parent?: string | PaseoAgentHandle;
  title?: PaseoAgentSessionConfig["title"];
  env?: CreateAgentRequestMessage["env"];
  prompt?: string;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: CreateAgentRequestMessage["images"];
  attachments?: CreateAgentRequestMessage["attachments"];
  git?: CreateAgentRequestMessage["git"];
  worktree?: CreateAgentRequestMessage["worktree"];
  autoArchive?: CreateAgentRequestMessage["autoArchive"];
  requestId?: string;
  labels?: Record<string, string>;
}

export type PaseoWorkspaceAgentCreateOptions = Omit<PaseoAgentCreateOptions, "cwd">;

export interface PaseoAgentRefetchResult {
  agent: PaseoAgent;
  project: ProjectPlacementPayload | null;
}

export interface PaseoAgentTimelineRefetchOptions {
  direction?: FetchAgentTimelineDirection;
  cursor?: FetchAgentTimelineCursor;
  limit?: number;
  projection?: FetchAgentTimelineProjection;
  requestId?: string;
}

export interface PaseoAgentSendOptions {
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: SendAgentMessageRequest["attachments"];
}

export interface PaseoAgentRunOptions extends PaseoAgentSendOptions {
  timeoutMs?: number;
}

export type PaseoAgentRunResult = WaitForFinishResult;
export type PaseoAgentPermissionResponse = AgentPermissionResponse;

export interface PaseoAgentRespondToPermissionOptions {
  requestId: string;
  response: PaseoAgentPermissionResponse;
}

export interface PaseoAgentCommandsOptions {
  requestId?: string;
}

export type PaseoAgentCommandsResult = ListCommandsResponse["payload"];

export type PaseoAgentUpdate = Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"];

export type PaseoAgentStream = Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"];

export type PaseoAgentUpdateHandler = (update: PaseoAgentUpdate) => void;

export type PaseoAgentTimelineEvent =
  | PaseoAgentStream
  | {
      agentId: string;
      event: { type: "replacement"; epoch: string };
    }
  | {
      agentId: string;
      subscriptionId: string;
      event: { type: "snapshot"; reason: "reconnect"; page: FetchAgentTimelinePayload };
    }
  | { agentId: string; event: { type: "error"; error: string } };

export type PaseoAgentTimelineSubscription = ReturnType<DaemonClient["subscribeAgentTimeline"]>;

export interface PaseoAgentTimelineHandle {
  append(item: Omit<PluginTimelineItem, "pluginId">): Promise<{ seq: number; epoch: string }>;
  /**
   * Fetches a fresh timeline page through the existing daemon RPC. If the daemon
   * includes an agent snapshot in the response, the parent handle is updated to
   * that value.
   */
  refetch(options?: PaseoAgentTimelineRefetchOptions): Promise<FetchAgentTimelinePayload>;
  /**
   * Initially delivers live events only. Reconnect delivers a projected snapshot
   * of the latest 100 entries before subsequent updates. Replace your recent view
   * with this page; use its cursors to load older history. A replacement event
   * invalidates the previous epoch. Recovery errors release this observation.
   * Await the returned unsubscribe function's `ready` promise before starting
   * work that must be observed. It rejects if establishment fails.
   */
  subscribe(handler: (event: PaseoAgentTimelineEvent) => void): PaseoAgentTimelineSubscription;
}

export interface PaseoAgentHandle {
  readonly id: string;
  /**
   * `workspaceId` through `archivedAt` mirror the last snapshot this handle
   * observed. A handle from `ref()` reads `null` for all of them until
   * `refresh()`, `run()`, `waitForFinish()`, a timeline refetch, or
   * `subscribe()` delivers a snapshot. Optional snapshot values also read as
   * `null`; use `current()` when you need to distinguish those states.
   */
  readonly workspaceId: string | null;
  readonly cwd: string | null;
  readonly status: PaseoAgent["status"] | null;
  readonly capabilities: PaseoAgent["capabilities"] | null;
  readonly availableModes: PaseoAgent["availableModes"] | null;
  readonly pendingPermissions: PaseoAgent["pendingPermissions"] | null;
  readonly activeTurn: NonNullable<PaseoAgent["activeTurn"]> | null;
  readonly lastUsage: NonNullable<PaseoAgent["lastUsage"]> | null;
  readonly lastError: NonNullable<PaseoAgent["lastError"]> | null;
  readonly features: NonNullable<PaseoAgent["features"]> | null;
  readonly runtimeInfo: NonNullable<PaseoAgent["runtimeInfo"]> | null;
  readonly archivedAt: NonNullable<PaseoAgent["archivedAt"]> | null;
  readonly timeline: PaseoAgentTimelineHandle;
  current(): PaseoAgent | null;
  refresh(requestId?: string): Promise<PaseoAgentRefetchResult | null>;
  send(text: string, options?: PaseoAgentSendOptions): Promise<void>;
  respondToPermission(options: PaseoAgentRespondToPermissionOptions): Promise<void>;
  /** Sends a prompt and resolves when that turn finishes or needs attention. */
  run(text: string, options?: PaseoAgentRunOptions): Promise<PaseoAgentRunResult>;
  /** Waits for the current turn, including one started with `prompt`. */
  waitForFinish(timeoutMs?: number): Promise<PaseoAgentRunResult>;
  /**
   * Asks the running session for the slash commands and skills it actually
   * loaded. Providers answer from the live session, so this sees built-in and
   * bundled entries that no directory scan can find. The payload carries its own
   * `error` string; a provider that cannot answer reports it there rather than
   * rejecting.
   */
  commands(options?: PaseoAgentCommandsOptions): Promise<PaseoAgentCommandsResult>;
  archive(): Promise<{ archivedAt: string }>;
  detach(): Promise<void>;
  subscribe(handler: (update: PaseoAgentUpdate) => void): () => void;
}

export interface PaseoAgentActions {
  list(options: PaseoAgentListOptions & { subscribe: {} }): Promise<
    PaseoAgentListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<PaseoAgentListResult>;
    }
  >;
  list(options?: PaseoAgentListOptions): Promise<PaseoAgentListResult>;
  ref(agent: string | PaseoAgent): PaseoAgentHandle;
  create(options: PaseoAgentCreateOptions): Promise<PaseoAgentHandle>;
  /**
   * Local event subscription over the low-level driver's agent_update stream.
   * The returned function only removes this SDK listener.
   */
  subscribe(handler: PaseoAgentUpdateHandler): () => void;
}

export type PaseoProviderModelsResult = ListProviderModelsResponseMessage["payload"];
export type PaseoProviderModesResult = ListProviderModesResponseMessage["payload"];
type PaseoProviderFeaturesDraft = ListProviderFeaturesRequestMessage["draftConfig"];
export interface PaseoProviderFeaturesInput extends Omit<
  PaseoProviderFeaturesDraft,
  "provider" | "model"
> {
  /** Provider and model in `provider/model` format. */
  provider: string;
}
export type PaseoProviderFeaturesResult = ListProviderFeaturesResponseMessage["payload"];
export type PaseoProviderAvailabilityResult = ListAvailableProvidersResponse["payload"];
export type PaseoProviderSnapshotResult = GetProvidersSnapshotResponseMessage["payload"];
export type PaseoProviderSnapshotUpdate = Extract<
  SessionOutboundMessage,
  { type: "providers_snapshot_update" }
>["payload"];
export type PaseoProviderRefreshResult = RefreshProvidersSnapshotResponseMessage["payload"];
export type PaseoProviderDiagnosticResult = ProviderDiagnosticResponseMessage["payload"];
export type PaseoProviderUsageResult = ProviderUsageListResponseMessage["payload"];
export interface PaseoProviderUsageOptions {
  requestId?: string;
}

export interface PaseoProviderListOptions {
  cwd?: string;
  requestId?: string;
}

export interface PaseoProviderRefreshOptions {
  cwd?: string;
  providers?: PaseoAgentProvider[];
  requestId?: string;
}

export interface PaseoProviderWaitOptions extends PaseoProviderListOptions {
  timeoutMs?: number;
}

export interface PaseoProviderActions {
  listModels(
    provider: PaseoAgentProvider,
    options?: PaseoProviderListOptions,
  ): Promise<PaseoProviderModelsResult>;
  listModes(
    provider: PaseoAgentProvider,
    options?: PaseoProviderListOptions,
  ): Promise<PaseoProviderModesResult>;
  listFeatures(
    draftConfig: PaseoProviderFeaturesInput,
    options?: { requestId?: string },
  ): Promise<PaseoProviderFeaturesResult>;
  listAvailable(options?: { requestId?: string }): Promise<PaseoProviderAvailabilityResult>;
  snapshot(options?: PaseoProviderListOptions): Promise<PaseoProviderSnapshotResult>;
  /** Resolves after the daemon's lazy provider discovery has finished. */
  waitForReady(options?: PaseoProviderWaitOptions): Promise<PaseoProviderSnapshotResult>;
  refresh(options?: PaseoProviderRefreshOptions): Promise<PaseoProviderRefreshResult>;
  diagnostic(
    provider: PaseoAgentProvider,
    options?: { requestId?: string },
  ): Promise<PaseoProviderDiagnosticResult>;
  listUsage(options?: PaseoProviderUsageOptions): Promise<PaseoProviderUsageResult>;
  subscribe(handler: (update: PaseoProviderSnapshotUpdate) => void): () => void;
}

export interface PaseoConfigActions {
  /**
   * Reads daemon config through the existing config RPC. Provider profiles,
   * custom provider entries, keys/env, custom binaries, and provider enablement
   * are currently config-file-shaped daemon state, so the SDK exposes this raw
   * typed surface instead of pretending there are higher-level provider-settings
   * RPCs.
   */
  get(requestId?: string): Promise<{ requestId: string; config: MutableDaemonConfig }>;
  /**
   * Patches daemon config through the existing config RPC. The daemon validates
   * and persists supported fields; unsupported provider/settings workflows remain
   * daemon gaps until first-class RPCs exist.
   */
  patch(
    config: MutableDaemonConfigPatch,
    requestId?: string,
  ): Promise<{ requestId: string; config: MutableDaemonConfig }>;
}

export interface PaseoApi {
  dispose(): Promise<void>;
  observeEvents: DaemonClient["observeEvents"];
  readonly terminals: PaseoTerminalActions;
  readonly workspaces: PaseoWorkspaceActions;
  readonly projects: PaseoProjectActions;
  readonly agents: PaseoAgentActions;
  readonly providers: PaseoProviderActions;
  readonly config: PaseoConfigActions;
}

export interface PaseoClient extends PaseoApi {
  connect(): Promise<void>;
  close(): Promise<void>;
  ensureConnected(): void;
  getConnectionState(): ConnectionState;
}

export function createPaseoClient(config: PaseoClientConfig): PaseoClient {
  const daemonClient = new DaemonClient({
    ...config,
    clientId: config.clientId ?? createGeneratedClientId(),
    clientType: "cli",
  });
  const api = createPaseoApi(daemonClient);
  return {
    ...api,
    connect: () => daemonClient.connect(),
    close: async () => {
      try {
        await api.dispose();
      } finally {
        await daemonClient.close();
      }
    },
    ensureConnected: () => daemonClient.ensureConnected(),
    getConnectionState: () => daemonClient.getConnectionState(),
  };
}

export function createPaseoApi(
  daemonClient: DaemonClient,
  scopeOptions?: { signal?: AbortSignal },
): PaseoApi {
  const handles = new Set<{ release(): Promise<void> }>();
  const agentListeners = new Set<PaseoAgentUpdateHandler>();
  const workspaceListeners = new Set<PaseoWorkspaceUpdateHandler>();
  const projectListeners = new Set<PaseoProjectUpdateHandler>();
  const providerListeners = new Set<(update: PaseoProviderSnapshotUpdate) => void>();
  const lifetime = new AbortController();
  const own = <T extends { release(): Promise<void> }>(create: () => T): T => {
    if (lifetime.signal.aborted) throw new Error("Paseo API is disposed");
    const handle = create();
    handles.add(handle);
    const release = handle.release.bind(handle);
    handle.release = async () => {
      await release();
      handles.delete(handle);
    };
    return handle;
  };
  const listenAgents = (handler: PaseoAgentUpdateHandler) => {
    if (lifetime.signal.aborted) throw new Error("Paseo API is disposed");
    agentListeners.add(handler);
    return () => {
      agentListeners.delete(handler);
    };
  };
  const listenWorkspaces = (handler: PaseoWorkspaceUpdateHandler) => {
    if (lifetime.signal.aborted) throw new Error("Paseo API is disposed");
    workspaceListeners.add(handler);
    return () => {
      workspaceListeners.delete(handler);
    };
  };
  const createAgentHandle = createAgentHandleFactory(
    daemonClient,
    listenAgents,
    (agentId, handler) => own(() => daemonClient.subscribeAgentTimeline(agentId, handler)),
  );
  const createAgent = async (
    options: PaseoAgentCreateOptions,
    placement?: { workspaceId: string; cwd: string },
  ) => {
    const { config: agentConfig, cwd, parent, title, prompt, ...requestOptions } = options;
    const { provider: providerModel, options: providerOptions, ...runtimeConfig } = agentConfig;
    const { provider, model } = parseProviderModel(providerModel);
    const effectiveCwd = placement?.cwd ?? cwd;
    const agent = await daemonClient.createAgent({
      ...requestOptions,
      config: {
        ...runtimeConfig,
        provider,
        model,
        cwd: effectiveCwd,
        ...(title !== undefined ? { title } : {}),
        ...(providerOptions !== undefined ? { providerOptions } : {}),
      },
      ...(placement ? { workspaceId: placement.workspaceId } : {}),
      ...(parent ? { callerAgentId: resolveAgentId(parent) } : {}),
      ...(prompt !== undefined ? { initialPrompt: prompt } : {}),
    });
    return createAgentHandle(agent);
  };
  const terminals = createTerminalActions(daemonClient, async (workspaceId) => {
    const workspace = await createWorkspaceHandle(workspaceId).refresh();
    if (!workspace?.workspaceDirectory) {
      throw new Error(`Workspace ${workspaceId} is not active or has no available directory`);
    }
    return workspace.workspaceDirectory;
  });
  const createWorkspaceHandle = createWorkspaceHandleFactory(
    daemonClient,
    createAgent,
    terminals,
    listenWorkspaces,
  );

  let disposal: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    lifetime.abort();
    scopeOptions?.signal?.removeEventListener("abort", abort);
    agentListeners.clear();
    workspaceListeners.clear();
    projectListeners.clear();
    providerListeners.clear();
    disposal = Promise.allSettled([...handles].map((handle) => handle.release())).then(
      (results) => {
        handles.clear();
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(failures, "Failed to release API subscriptions");
        return undefined;
      },
    );
    return disposal;
  };
  const abort = () => {
    void dispose().catch((error) => console.error("API subscription cleanup failed", error));
  };
  if (scopeOptions?.signal?.aborted) abort();
  else scopeOptions?.signal?.addEventListener("abort", abort, { once: true });

  const observeEvents: DaemonClient["observeEvents"] = (events, options) => {
    const subscription = own(() => daemonClient.observeEvents(events, options));
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "project.update")
          for (const listener of projectListeners) listener(message.payload);
        if (message.type === "providers_snapshot_update")
          for (const listener of providerListeners) listener(message.payload);
      },
    });
    return subscription;
  };

  function listWorkspaces(options: PaseoWorkspaceListOptions & { subscribe: {} }): Promise<
    PaseoWorkspaceListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<PaseoWorkspaceListResult>;
    }
  >;
  function listWorkspaces(options?: PaseoWorkspaceListOptions): Promise<PaseoWorkspaceListResult>;
  async function listWorkspaces(
    options?: PaseoWorkspaceListOptions,
  ): Promise<PaseoWorkspaceListResult> {
    if (!options?.subscribe) return daemonClient.fetchWorkspaces(options);
    if (options.subscribe.subscriptionId !== undefined)
      throw new Error("Subscription IDs are assigned by the host");
    const subscription = own(() => daemonClient.observeWorkspaces(options));
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "workspace_update")
          for (const listener of workspaceListeners) listener(message.payload);
      },
    });
    return { ...(await subscription.ready), subscription };
  }

  function listAgents(options: PaseoAgentListOptions & { subscribe: {} }): Promise<
    PaseoAgentListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<PaseoAgentListResult>;
    }
  >;
  function listAgents(options?: PaseoAgentListOptions): Promise<PaseoAgentListResult>;
  async function listAgents(options?: PaseoAgentListOptions): Promise<PaseoAgentListResult> {
    if (!options?.subscribe) return daemonClient.fetchAgents(options);
    if (options.subscribe.subscriptionId !== undefined)
      throw new Error("Subscription IDs are assigned by the host");
    const subscription = own(() => daemonClient.observeAgents(options));
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "agent_update")
          for (const listener of agentListeners) listener(message.payload);
      },
    });
    return { ...(await subscription.ready), subscription };
  }

  return {
    dispose,
    observeEvents,
    terminals,
    projects: {
      list: (options) => daemonClient.listProjects(options),
      subscribe: (handler) => {
        if (lifetime.signal.aborted) throw new Error("Paseo API is disposed");
        projectListeners.add(handler);
        return () => {
          projectListeners.delete(handler);
        };
      },
    },
    workspaces: {
      list: listWorkspaces,
      ref: (workspace) => createWorkspaceHandle(workspace),
      open: (input, requestId) =>
        openWorkspace(daemonClient, createWorkspaceHandle, input, requestId),
      create: async ({ requestId, ...options }) => {
        const result = await daemonClient.createWorkspace(options, requestId);
        if (result.error || !result.workspace) {
          throw new Error(result.error ?? "The daemon did not create a workspace");
        }
        return createWorkspaceHandle(result.workspace);
      },
      archive: (workspace, requestId) =>
        daemonClient.archiveWorkspace(resolveWorkspaceId(workspace), requestId),
      subscribe: listenWorkspaces,
    },
    agents: {
      list: listAgents,
      ref: (agent) => createAgentHandle(agent),
      create: (options) => createAgent(options),
      subscribe: listenAgents,
    },
    providers: {
      listModels: (provider, options) => daemonClient.listProviderModels(provider, options),
      listModes: (provider, options) => daemonClient.listProviderModes(provider, options),
      listFeatures: ({ provider: providerModel, ...draftConfig }, options) => {
        const { provider, model } = parseProviderModel(providerModel);
        return daemonClient.listProviderFeatures({ ...draftConfig, provider, model }, options);
      },
      listAvailable: (options) => daemonClient.listAvailableProviders(options),
      snapshot: (options) => daemonClient.getProvidersSnapshot(options),
      waitForReady: (options) =>
        waitForProvidersReady(
          daemonClient,
          observeEvents(["providers_snapshot_update"]),
          lifetime.signal,
          options,
        ),
      refresh: (options) => daemonClient.refreshProvidersSnapshot(options),
      diagnostic: (provider, options) => daemonClient.getProviderDiagnostic(provider, options),
      listUsage: (options) => listProviderUsage(daemonClient, options),
      subscribe: (handler) => {
        if (lifetime.signal.aborted) throw new Error("Paseo API is disposed");
        providerListeners.add(handler);
        return () => {
          providerListeners.delete(handler);
        };
      },
    },
    config: {
      get: (requestId) => daemonClient.getDaemonConfig(requestId),
      patch: (patch, requestId) => daemonClient.patchDaemonConfig(patch, requestId),
    },
  };
}

type WorkspaceHandleFactory = (workspace: string | PaseoWorkspace) => PaseoWorkspaceHandle;
type AgentHandleFactory = (agent: string | PaseoAgent) => PaseoAgentHandle;
type CreateAgent = (
  options: PaseoAgentCreateOptions,
  placement?: { workspaceId: string; cwd: string },
) => Promise<PaseoAgentHandle>;

function createWorkspaceHandleFactory(
  daemonClient: DaemonClient,
  createAgent: CreateAgent,
  terminals: PaseoTerminalActions,
  listen: (handler: PaseoWorkspaceUpdateHandler) => () => void,
): WorkspaceHandleFactory {
  return (workspace) => {
    const id = typeof workspace === "string" ? workspace : workspace.id;
    let current = typeof workspace === "string" ? null : workspace;

    const refresh = async (options?: { requestId?: string }) => {
      let cursor: string | undefined;
      let requestId = options?.requestId;
      do {
        const result = await daemonClient.fetchWorkspaces({
          requestId,
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        const match = result.entries.find((entry) => entry.id === id);
        if (match) {
          current = match;
          return current;
        }
        cursor = result.pageInfo.nextCursor ?? undefined;
        requestId = undefined;
      } while (cursor);
      current = null;
      return current;
    };

    return {
      id,
      get projectId() {
        return current?.projectId ?? null;
      },
      get directory() {
        return current?.workspaceDirectory ?? null;
      },
      get name() {
        return current?.name ?? null;
      },
      get status() {
        return current?.status ?? null;
      },
      agents: {
        create: async (options) => {
          const snapshot = current ?? (await refresh());
          if (!snapshot?.workspaceDirectory) {
            throw new Error(`Workspace ${id} has no available directory`);
          }
          return createAgent(
            { ...options, cwd: snapshot.workspaceDirectory },
            { workspaceId: id, cwd: snapshot.workspaceDirectory },
          );
        },
      },
      terminals: {
        create: (options) => terminals.create({ ...options, workspaceId: id }),
        list: (options) => terminals.list({ ...options, workspaceId: id }),
      },
      current: () => current,
      refresh,
      setTitle: (title, requestId) => daemonClient.setWorkspaceTitle(id, title, requestId),
      archive: async (requestId) => {
        const result = await daemonClient.archiveWorkspace(id, requestId);
        if (current) {
          current = { ...current, archivingAt: result.archivedAt };
        }
        return result;
      },
      subscribe: (handler) =>
        listen((update) => {
          if (update.kind === "upsert" && update.workspace.id === id) {
            current = update.workspace;
            handler(update);
          }
          if (update.kind === "remove" && update.id === id) {
            handler(update);
          }
        }),
    };
  };
}

function createAgentHandleFactory(
  daemonClient: DaemonClient,
  listen: (handler: PaseoAgentUpdateHandler) => () => void,
  subscribeTimeline: DaemonClient["subscribeAgentTimeline"],
): AgentHandleFactory {
  return (agent) => {
    const id = typeof agent === "string" ? agent : agent.id;
    let current = typeof agent === "string" ? null : agent;

    const handle: PaseoAgentHandle = {
      id,
      timeline: {
        append: (item) => daemonClient.appendAgentTimelineItem(id, item),
        refetch: async (options) => {
          const result = await daemonClient.fetchAgentTimeline(id, options);
          if (result.agent) {
            current = result.agent;
          }
          return result;
        },
        subscribe: (handler) =>
          subscribeTimeline(id, (message) => {
            switch (message.type) {
              case "agent_stream":
                return handler(message.payload);
              case "agent.timeline.snapshot":
                return handler({
                  agentId: id,
                  subscriptionId: message.payload.subscriptionId,
                  event: { type: "snapshot", reason: "reconnect", page: message.payload.page },
                });
              case "agent.timeline.error":
                return handler({
                  agentId: id,
                  event: { type: "error", error: message.payload.error },
                });
              case "agent.timeline.replacement":
                return handler({
                  agentId: id,
                  event: { type: "replacement", epoch: message.payload.epoch },
                });
            }
          }),
      },
      get workspaceId() {
        return current?.workspaceId ?? null;
      },
      get cwd() {
        return current?.cwd ?? null;
      },
      get status() {
        return current?.status ?? null;
      },
      get capabilities() {
        return current?.capabilities ?? null;
      },
      get availableModes() {
        return current?.availableModes ?? null;
      },
      get pendingPermissions() {
        return current?.pendingPermissions ?? null;
      },
      get activeTurn() {
        return current?.activeTurn ?? null;
      },
      get lastUsage() {
        return current?.lastUsage ?? null;
      },
      get lastError() {
        return current?.lastError ?? null;
      },
      get features() {
        return current?.features ?? null;
      },
      get runtimeInfo() {
        return current?.runtimeInfo ?? null;
      },
      get archivedAt() {
        return current?.archivedAt ?? null;
      },
      current: () => current,
      refresh: async (requestId) => {
        const result = await daemonClient.fetchAgent({ agentId: id, requestId });
        current = result?.agent ?? null;
        return result;
      },
      send: async (text, options) => {
        await daemonClient.sendAgentMessage(id, text, options);
      },
      respondToPermission: async ({ requestId, response }) => {
        await daemonClient.respondToPermission(id, requestId, response);
      },
      run: async (text, options) => {
        const { timeoutMs, ...sendOptions } = options ?? {};
        await daemonClient.sendAgentMessage(id, text, sendOptions);
        const result = await daemonClient.waitForFinish(
          id,
          timeoutMs ?? DEFAULT_WAIT_FOR_FINISH_MS,
        );
        if (result.final) {
          current = result.final;
        }
        return result;
      },
      waitForFinish: async (timeoutMs) => {
        const result = await daemonClient.waitForFinish(
          id,
          timeoutMs ?? DEFAULT_WAIT_FOR_FINISH_MS,
        );
        if (result.final) {
          current = result.final;
        }
        return result;
      },
      commands: (options) => daemonClient.listCommands({ agentId: id, ...options }),
      archive: async () => {
        const result = await daemonClient.archiveAgent(id);
        if (current) {
          current = { ...current, archivedAt: result.archivedAt };
        }
        return result;
      },
      detach: async () => {
        await daemonClient.detachAgent(id);
      },
      subscribe: (handler) =>
        listen((update) => {
          if (update.kind === "upsert" && update.agent.id === id) {
            current = update.agent;
            handler(update);
          }
          if (update.kind === "remove" && update.agentId === id) {
            handler(update);
          }
        }),
    };

    return handle;
  };
}

async function openWorkspace(
  daemonClient: DaemonClient,
  createWorkspaceHandle: WorkspaceHandleFactory,
  input: string | PaseoWorkspaceOpenOptions,
  requestId?: string,
): Promise<PaseoWorkspaceHandle> {
  const options = typeof input === "string" ? { cwd: input, requestId } : input;
  const result = await daemonClient.openProject(options.cwd, options.requestId);
  if (result.error || !result.workspace) {
    throw new Error(result.error ?? `The daemon did not open a workspace for ${options.cwd}`);
  }
  return createWorkspaceHandle(result.workspace);
}

function resolveWorkspaceId(workspace: string | PaseoWorkspaceHandle): string {
  return typeof workspace === "string" ? workspace : workspace.id;
}

function resolveAgentId(agent: string | PaseoAgentHandle): string {
  return typeof agent === "string" ? agent : agent.id;
}

function parseProviderModel(selection: string): { provider: string; model: string } {
  const separator = selection.indexOf("/");
  if (separator <= 0 || separator === selection.length - 1) {
    throw new Error('Expected config.provider in "provider/model" format');
  }
  return {
    provider: selection.slice(0, separator),
    model: selection.slice(separator + 1),
  };
}

function listProviderUsage(
  daemonClient: DaemonClient,
  options?: PaseoProviderUsageOptions,
): Promise<PaseoProviderUsageResult> {
  // COMPAT(providerUsageList): added in v0.1.98, remove after 2027-02-28 once daemon floor >= v0.1.98.
  if (daemonClient.getLastServerInfoMessage()?.features?.providerUsageList !== true) {
    return Promise.reject(new Error("Update the host to list provider usage."));
  }
  return daemonClient.listProviderUsage(options);
}

async function waitForProvidersReady(
  daemonClient: DaemonClient,
  observation: ReturnType<DaemonClient["observeEvents"]>,
  signal: AbortSignal,
  options: PaseoProviderWaitOptions = {},
): Promise<PaseoProviderSnapshotResult> {
  const { timeoutMs = 60_000, ...snapshotOptions } = options;

  try {
    await observation.ready;
    signal.throwIfAborted();
    return await new Promise<PaseoProviderSnapshotResult>((resolve, reject) => {
      let settled = false;
      let requestId: string | null = null;
      let snapshotCwd: string | undefined;
      const pendingUpdates = new Map<string | undefined, PaseoProviderSnapshotUpdate>();
      let latestEntries: PaseoProviderSnapshotResult["entries"] = [];

      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribe();
        signal.removeEventListener("abort", abort);
      };
      const finish = (snapshot: PaseoProviderSnapshotResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(snapshot);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const updateMatches = (update: PaseoProviderSnapshotUpdate) => update.cwd === snapshotCwd;

      const unsubscribe = observation.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type !== "providers_snapshot_update") return;
          const update = message.payload;
          if (!requestId) {
            pendingUpdates.set(update.cwd, update);
            return;
          }
          if (!updateMatches(update)) return;
          latestEntries = update.entries;
          if (update.entries.some((entry) => entry.status === "loading")) return;
          finish({ ...update, requestId });
        },
      });
      const abort = () => fail(new Error("Paseo API is disposed"));
      signal.addEventListener("abort", abort, { once: true });

      const timeout = setTimeout(() => {
        const loading = latestEntries
          .filter((entry) => entry.status === "loading")
          .map((entry) => entry.provider)
          .join(", ");
        fail(
          new Error(
            loading
              ? `Timed out waiting for providers: ${loading}`
              : "Timed out waiting for provider discovery",
          ),
        );
      }, timeoutMs);

      void daemonClient
        .getProvidersSnapshot(snapshotOptions)
        .then((snapshot) => {
          requestId = snapshot.requestId;
          snapshotCwd = snapshot.cwd;
          latestEntries = snapshot.entries;
          if (!snapshot.entries.some((entry) => entry.status === "loading")) {
            finish(snapshot);
            return;
          }
          const pendingUpdate = pendingUpdates.get(snapshotCwd);
          if (pendingUpdate && !pendingUpdate.entries.some((entry) => entry.status === "loading")) {
            finish({ ...pendingUpdate, requestId });
          }
          return undefined;
        })
        .catch(fail);
    });
  } finally {
    await observation.release();
  }
}

function createGeneratedClientId(): string {
  const randomId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `paseo-sdk-${randomId}`;
}
