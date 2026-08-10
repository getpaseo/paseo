import type {
  AgentSnapshotPayload,
  CreateAgentRequestMessage,
  FetchWorkspacesRequestMessage,
  FetchWorkspacesResponseMessage,
  GetProvidersSnapshotResponseMessage,
  ListAvailableProvidersResponse,
  ListProviderFeaturesRequestMessage,
  ListProviderFeaturesResponseMessage,
  ListProviderModelsResponseMessage,
  ListProviderModesResponseMessage,
  MutableDaemonConfig,
  MutableDaemonConfigPatch,
  ProviderDiagnosticResponseMessage,
  ProjectPlacementPayload,
  RefreshProvidersSnapshotResponseMessage,
  SendAgentMessageRequest,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
  WorkspaceCreateRequest,
} from "@getpaseo/protocol/messages";
import { DaemonClient } from "./daemon-client.js";
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

export interface PaseoAgentListResult {
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
  current(): PaseoWorkspace | null;
  refresh(options?: { requestId?: string }): Promise<PaseoWorkspace | null>;
  archive(requestId?: string): Promise<PaseoWorkspaceArchiveResult>;
  /**
   * Subscribes to already-emitted daemon workspace_update events for this id.
   * This returns a local unsubscribe function; it does not own app cache state or
   * send a daemon unsubscribe RPC. Call `workspaces.list({ subscribe: {} })` when
   * the daemon should start streaming workspace directory updates.
   */
  subscribe(handler: (update: PaseoWorkspaceUpdate) => void): () => void;
}

export interface PaseoWorkspaceActions {
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

export type PaseoAgentUpdate = Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"];

export type PaseoAgentStream = Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"];

export type PaseoAgentUpdateHandler = (update: PaseoAgentUpdate) => void;

export interface PaseoAgentTimelineHandle {
  /**
   * Fetches a fresh timeline page through the existing daemon RPC. If the daemon
   * includes an agent snapshot in the response, the parent handle is updated to
   * that value.
   */
  refetch(options?: PaseoAgentTimelineRefetchOptions): Promise<FetchAgentTimelinePayload>;
  /**
   * Local listener for agent_stream events matching this handle id. It does not
   * retain timeline entries or own application cache state.
   */
  subscribe(handler: (event: PaseoAgentStream) => void): () => void;
}

export interface PaseoAgentHandle {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly cwd: string | null;
  readonly status: PaseoAgent["status"] | null;
  readonly timeline: PaseoAgentTimelineHandle;
  current(): PaseoAgent | null;
  refresh(requestId?: string): Promise<PaseoAgentRefetchResult | null>;
  send(text: string, options?: PaseoAgentSendOptions): Promise<void>;
  /** Sends a prompt and resolves when that turn finishes or needs attention. */
  run(text: string, options?: PaseoAgentRunOptions): Promise<PaseoAgentRunResult>;
  /** Waits for the current turn, including one started with `prompt`. */
  waitForFinish(timeoutMs?: number): Promise<PaseoAgentRunResult>;
  archive(): Promise<{ archivedAt: string }>;
  detach(): Promise<void>;
  subscribe(handler: (update: PaseoAgentUpdate) => void): () => void;
}

export interface PaseoAgentActions {
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

export interface PaseoClient {
  readonly workspaces: PaseoWorkspaceActions;
  readonly agents: PaseoAgentActions;
  readonly providers: PaseoProviderActions;
  readonly config: PaseoConfigActions;
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
  const createAgentHandle = createAgentHandleFactory(daemonClient);
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
  const createWorkspaceHandle = createWorkspaceHandleFactory(daemonClient, createAgent);

  return {
    workspaces: {
      list: (options) => daemonClient.fetchWorkspaces(options),
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
      subscribe: (handler) =>
        daemonClient.on("workspace_update", (message) => {
          handler(message.payload);
        }),
    },
    agents: {
      list: (options) => daemonClient.fetchAgents(options),
      ref: (agent) => createAgentHandle(agent),
      create: (options) => createAgent(options),
      subscribe: (handler) =>
        daemonClient.on("agent_update", (message) => {
          handler(message.payload);
        }),
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
      waitForReady: (options) => waitForProvidersReady(daemonClient, options),
      refresh: (options) => daemonClient.refreshProvidersSnapshot(options),
      diagnostic: (provider, options) => daemonClient.getProviderDiagnostic(provider, options),
      subscribe: (handler) =>
        daemonClient.on("providers_snapshot_update", (message) => {
          handler(message.payload);
        }),
    },
    config: {
      get: (requestId) => daemonClient.getDaemonConfig(requestId),
      patch: (patch, requestId) => daemonClient.patchDaemonConfig(patch, requestId),
    },
    connect: () => daemonClient.connect(),
    close: () => daemonClient.close(),
    ensureConnected: () => daemonClient.ensureConnected(),
    getConnectionState: () => daemonClient.getConnectionState(),
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
      current: () => current,
      refresh,
      archive: async (requestId) => {
        const result = await daemonClient.archiveWorkspace(id, requestId);
        if (current) {
          current = { ...current, archivingAt: result.archivedAt };
        }
        return result;
      },
      subscribe: (handler) =>
        daemonClient.on("workspace_update", (message) => {
          const update = message.payload;
          if (update.kind === "upsert" && update.workspace.id === id) {
            current = update.workspace;
            handler(update);
          }
          if (update.kind === "remove" && update.id === id) {
            current = null;
            handler(update);
          }
        }),
    };
  };
}

function createAgentHandleFactory(daemonClient: DaemonClient): AgentHandleFactory {
  return (agent) => {
    const id = typeof agent === "string" ? agent : agent.id;
    let current = typeof agent === "string" ? null : agent;

    const handle: PaseoAgentHandle = {
      id,
      timeline: {
        refetch: async (options) => {
          const result = await daemonClient.fetchAgentTimeline(id, options);
          if (result.agent) {
            current = result.agent;
          }
          return result;
        },
        subscribe: (handler) =>
          daemonClient.on("agent_stream", (message) => {
            if (message.payload.agentId === id) {
              handler(message.payload);
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
      current: () => current,
      refresh: async (requestId) => {
        const result = await daemonClient.fetchAgent({ agentId: id, requestId });
        current = result?.agent ?? null;
        return result;
      },
      send: async (text, options) => {
        await daemonClient.sendAgentMessage(id, text, options);
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
        daemonClient.on("agent_update", (message) => {
          const update = message.payload;
          if (update.kind === "upsert" && update.agent.id === id) {
            current = update.agent;
            handler(update);
          }
          if (update.kind === "remove" && update.agentId === id) {
            current = null;
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

function waitForProvidersReady(
  daemonClient: DaemonClient,
  options: PaseoProviderWaitOptions = {},
): Promise<PaseoProviderSnapshotResult> {
  const { timeoutMs = 60_000, ...snapshotOptions } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    let requestId: string | null = null;
    let readyUpdate: PaseoProviderSnapshotUpdate | null = null;
    let latestEntries: PaseoProviderSnapshotResult["entries"] = [];

    const cleanup = () => {
      clearTimeout(timeout);
      unsubscribe();
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
    const updateMatches = (update: PaseoProviderSnapshotUpdate) =>
      update.cwd === snapshotOptions.cwd ||
      (update.cwd === undefined && snapshotOptions.cwd === undefined);

    const unsubscribe = daemonClient.on("providers_snapshot_update", (message) => {
      const update = message.payload;
      if (!updateMatches(update)) return;
      latestEntries = update.entries;
      if (update.entries.some((entry) => entry.status === "loading")) return;
      if (!requestId) {
        readyUpdate = update;
        return;
      }
      finish({ ...update, requestId });
    });

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
        latestEntries = snapshot.entries;
        if (!snapshot.entries.some((entry) => entry.status === "loading")) {
          finish(snapshot);
          return;
        }
        if (readyUpdate) {
          finish({ ...readyUpdate, requestId });
        }
        return undefined;
      })
      .catch(fail);
  });
}

function createGeneratedClientId(): string {
  const randomId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `paseo-sdk-${randomId}`;
}
