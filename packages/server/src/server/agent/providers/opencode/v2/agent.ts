import { structuredOutput } from "./structured-output.js";
import type {
  SessionInfo,
  SessionMessageInfo,
  FormInfo,
  FormValue,
  PermissionRuleset,
} from "@opencode/client";
import type { V2Api } from "./api.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateSessionOptions,
  AgentFeature,
  AgentLaunchContext,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentSlashCommand,
  FetchCatalogOptions,
  ImportableProviderSession,
  ImportProviderSessionInput,
  ImportProviderSessionContext,
  ListImportableSessionsOptions,
  ProviderRefreshContext,
  SteerActiveTurnOptions,
  SteerResult,
} from "../../../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../../../provider-launch-config.js";
import type { ManagedProcessRegistry } from "../../../../managed-processes/managed-processes.js";
import { toDiagnosticErrorMessage } from "../../diagnostic-utils.js";
import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";
import { runProviderTurn } from "../../provider-runner.js";
import { importSessionFromPersistence } from "../../../provider-session-import.js";
import { renderPromptAttachmentAsText } from "../../../prompt-attachments.js";
import { composeSystemPromptParts } from "../../../system-prompt.js";
import { raceProviderRefreshAbort } from "../../../provider-refresh-deadline.js";
import { OpenCodeProviderOptionsSchema, buildOpenCodePermissionRules } from "../options.js";
import type { OpenCodeBridge } from "../bridge.js";
import { resolveOpenCodeHomeDir } from "../paths.js";
import { V2Runtime, type V2Connection } from "./runtime.js";
import { modelRef, modesFromV2, modelsFromV2, usageFromV2, V2Timeline } from "./mapping.js";

export const V2_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindBoth: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
};

interface V2AgentOptions {
  logger: Logger;
  settings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  bridge?: OpenCodeBridge;
  runtime?: Pick<V2Runtime, "acquire" | "shutdown">;
}

export class OpenCodeV2AgentClient implements AgentClient {
  readonly provider = "opencode";
  readonly capabilities: AgentCapabilityFlags;
  private readonly runtime: Pick<V2Runtime, "acquire" | "shutdown">;
  private readonly connections = new Map<string, V2Connection>();
  constructor(private readonly options: V2AgentOptions) {
    this.capabilities = { ...V2_CAPABILITIES, supportsNativePaseoTools: Boolean(options.bridge) };
    this.runtime =
      options.runtime ??
      new V2Runtime({
        ...options,
        decorateEnv: options.bridge ? (env) => options.bridge!.decorateV2ServerEnv(env) : undefined,
      });
  }
  async isAvailable() {
    return true;
  }
  async shutdown() {
    await this.runtime.shutdown();
  }
  async fetchCatalog(options: FetchCatalogOptions, context?: ProviderRefreshContext) {
    const connection = await this.runtime.acquire({
      fresh: options.force,
      signal: context?.signal,
    });
    const location = {
      directory: options.scope === "workspace" ? options.cwd : resolveOpenCodeHomeDir(),
    };
    const request = { signal: context?.signal };
    const activity = <T>(name: string, operation: () => Promise<T>) =>
      context ? context.runActivity(name, operation) : operation();
    try {
      await activity("plugin.awaitActivation", () =>
        connection.client.plugin.awaitActivation({ location }, request),
      );
      const [models, agents, providers] = await Promise.all([
        activity("model.list", () => connection.client.model.list({ location }, request)),
        activity("agent.list", () => connection.client.agent.list({ location }, request)),
        activity("provider.list", () => connection.client.provider.list({ location }, request)),
      ]);
      if (!providers.data.length)
        throw new Error(
          "OpenCode has no connected providers. Authenticate using opencode auth login.",
        );
      return { models: modelsFromV2(models.data), modes: modesFromV2(agents.data) };
    } finally {
      await connection.release();
    }
  }
  async createSession(
    config: AgentSessionConfig,
    launch?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const connection = await this.runtime.acquire({
      env: launch?.env,
      dedicated: Boolean(Object.keys(config.mcpServers ?? {}).length),
    });
    try {
      const info = await connection.client.session.create({
        location: { directory: config.cwd },
        title: config.title,
        agent: config.modeId ?? "build",
        model: config.model ? modelRef(config.model, config.thinkingOptionId) : undefined,
        permissions: permissionRules(config),
      });
      return await this.attach(connection, info, config, launch, options?.persistSession !== false);
    } catch (error) {
      await connection.release();
      throw error;
    }
  }
  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launch?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const cwd = overrides?.cwd ?? handle.metadata?.cwd;
    if (typeof cwd !== "string")
      throw new Error("OpenCode resume requires the original working directory");
    const config: AgentSessionConfig = {
      ...handle.metadata,
      ...overrides,
      provider: "opencode",
      cwd,
    };
    const connection =
      this.connections.get(handle.nativeHandle ?? handle.sessionId)?.retain() ??
      (await this.runtime.acquire({
        env: launch?.env,
        dedicated: Boolean(Object.keys(config.mcpServers ?? {}).length),
      }));
    try {
      const info = await connection.client.session.get({
        sessionID: handle.nativeHandle ?? handle.sessionId,
      });
      await applyResumeOverrides(connection.client, info, overrides);
      return await this.attach(connection, info, config, launch, true);
    } catch (error) {
      await connection.release();
      throw error;
    }
  }
  private async attach(
    connection: V2Connection,
    info: SessionInfo,
    config: AgentSessionConfig,
    launch: AgentLaunchContext | undefined,
    persist: boolean,
  ) {
    const unbind = this.options.bridge?.bindSession({
      sessionId: info.id,
      env: launch?.env ?? {},
      tools: launch?.paseoTools,
    });
    const bound = new Map<string, () => void>();
    const bindChild = (childId: string) => {
      this.connections.set(childId, connection);
      if (bound.has(childId)) return;
      const childUnbind = this.options.bridge?.bindSession({
        sessionId: childId,
        env: launch?.env ?? {},
        tools: launch?.paseoTools,
      });
      if (childUnbind) bound.set(childId, childUnbind);
    };
    this.connections.set(info.id, connection);
    const releaseBindings = () => {
      unbind?.();
      for (const cleanup of bound.values()) cleanup();
      for (const [id, owner] of this.connections)
        if (owner === connection) this.connections.delete(id);
    };
    const session = new OpenCodeV2Session(
      connection,
      info,
      config,
      this.options.logger,
      persist,
      releaseBindings,
      bindChild,
    );
    try {
      if (this.options.bridge) {
        const location = { directory: config.cwd };
        await connection.client.plugin.awaitActivation({ location });
        const plugins = await connection.client.plugin.list({ location });
        if (
          !plugins.data.some((plugin) => plugin.id === "paseo" && plugin.state.status === "active")
        )
          throw new Error("OpenCode v2 did not activate the Paseo tool bridge plugin");
      }
      await session.initialize(launch);
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
  async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
    return features(config);
  }
  async listCommands(config: AgentSessionConfig) {
    const connection = await this.runtime.acquire();
    try {
      return await commands(connection.client, config.cwd);
    } finally {
      await connection.release();
    }
  }
  async listImportableSessions(
    options: ListImportableSessionsOptions = {},
  ): Promise<ImportableProviderSession[]> {
    const connection = await this.runtime.acquire();
    try {
      const sessions: SessionInfo[] = [];
      let cursor: string | undefined;
      const scanLimit = Math.min(options.scanLimit ?? 100, 500);
      do {
        const page = await connection.client.session.list({
          ...(cursor ? { cursor } : { directory: options.cwd, search: options.query }),
          limit: Math.min(50, scanLimit - sessions.length),
        });
        sessions.push(...page.data);
        cursor = page.cursor.next ?? undefined;
      } while (cursor && sessions.length < scanLimit);
      return sessions
        .filter((info) => !info.parentID && !info.time.archived)
        .slice(0, options.limit ?? 50)
        .map((info) => ({
          providerHandleId: info.id,
          cwd: info.location.directory,
          title: info.title ?? null,
          firstPromptPreview: null,
          lastPromptPreview: null,
          lastActivityAt: new Date(info.time.updated),
        }));
    } finally {
      await connection.release();
    }
  }
  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    const connection = await this.runtime.acquire();
    try {
      const info = await connection.client.session.get({ sessionID: input.providerHandleId });
      return await importSessionFromPersistence({
        provider: "opencode",
        request: input,
        context,
        resumeSession: this.resumeSession.bind(this),
        config: {
          title: info.title,
          modeId: info.agent,
          model: info.model ? `${info.model.providerID}/${info.model.id}` : undefined,
        },
      });
    } finally {
      await connection.release();
    }
  }
}

function features(config: AgentSessionConfig): AgentFeature[] {
  return [
    {
      type: "toggle",
      id: "auto_accept",
      label: "Auto-accept",
      value: config.featureValues?.["auto_accept"] === true,
    },
  ];
}
function permissionRules(config: AgentSessionConfig): PermissionRuleset {
  const rules =
    buildOpenCodePermissionRules(
      OpenCodeProviderOptionsSchema.parse(config.providerOptions ?? {}),
      undefined,
    ) ?? [];
  const grants: PermissionRuleset = (config.toolPolicy?.preapproved ?? []).map((grant) => ({
    action: `${grant.server.replace(/[^a-zA-Z0-9_-]/g, "_")}_${grant.tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    resource: "*",
    effect: "allow",
  }));
  return [
    ...grants,
    ...rules.map((rule) => ({
      action: nativePermissionAction(rule.permission),
      resource: rule.pattern,
      effect: rule.action,
    })),
  ];
}
function nativePermissionAction(action: string): string {
  if (action === "bash") return "shell";
  if (action === "task") return "subagent";
  return action;
}
async function applyResumeOverrides(
  client: V2Api,
  info: SessionInfo,
  overrides?: Partial<AgentSessionConfig>,
) {
  if (overrides?.modeId) {
    await client.session.switchAgent({
      sessionID: info.id,
      agent: overrides.modeId,
    });
    info.agent = overrides.modeId;
  }
  if (overrides?.model || overrides?.thinkingOptionId !== undefined) {
    const model = overrides.model
      ? modelRef(overrides.model, overrides.thinkingOptionId ?? info.model?.variant)
      : info.model && { ...info.model, variant: overrides.thinkingOptionId };
    if (!model) throw new Error("Select an OpenCode model before changing its variant");
    await client.session.switchModel({ sessionID: info.id, model });
    info.model = model;
  }
}

async function commands(client: V2Api, directory: string): Promise<AgentSlashCommand[]> {
  const location = { directory };
  const [configured, skills] = await Promise.all([
    client.command.list({ location }),
    client.skill.list({ location }),
  ]);
  const result = new Map<string, AgentSlashCommand>();
  for (const name of ["compact", "summarize"])
    result.set(name, {
      name,
      description: "Compact the current session",
      argumentHint: "",
      kind: "command",
    });
  for (const command of configured.data)
    result.set(command.name, {
      name: command.name,
      description: command.description ?? "",
      argumentHint: "",
      kind: "command",
    });
  for (const skill of skills.data) {
    if (skill.slash === false || result.has(skill.id)) continue;
    result.set(skill.id, {
      name: skill.id,
      description: skill.description ?? "",
      argumentHint: "",
      kind: "skill",
    });
  }
  return [...result.values()];
}
async function messages(client: V2Api, sessionID: string): Promise<SessionMessageInfo[]> {
  const result: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.message.list({
      sessionID,
      ...(cursor ? { cursor } : { order: "asc" }),
      limit: 100,
    });
    result.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  return result;
}
interface Turn {
  output?: ReturnType<typeof structuredOutput>;
  id: string;
  submitted: Promise<void>;
  completion: Promise<void>;
}

export class OpenCodeV2Session implements AgentSession {
  readonly provider = "opencode";
  readonly capabilities = V2_CAPABILITIES;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private readonly timeline = new V2Timeline();
  private readonly abort = new AbortController();
  private readonly pending = new Map<string, AgentPermissionRequest>();
  private readonly permissionOwners = new Map<string, string>();
  private readonly forms = new Map<string, FormInfo>();
  private readonly children = new Map<string, V2Timeline>();
  private readonly childStates = new Map<string, string>();
  private stream: Promise<void> | null = null;
  private turn: Turn | null = null;
  private stopping: Promise<void> | null = null;
  private stopFailed = false;
  private sync: Promise<void> = Promise.resolve();
  private dirty = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private history: SessionMessageInfo[] = [];
  private lastError: string | null = null;
  private modes: AgentMode[] = [];
  constructor(
    private readonly connection: V2Connection,
    private info: SessionInfo,
    private readonly config: AgentSessionConfig,
    private readonly logger: Logger,
    private readonly persist: boolean,
    private readonly unbind?: () => void,
    private readonly bindChild?: (id: string) => void,
  ) {}
  get id() {
    return this.info.id;
  }
  get features() {
    return features(this.config);
  }
  private get client() {
    return this.connection.client;
  }
  async initialize(launch?: AgentLaunchContext) {
    void this.connection.exited.then((error) => {
      if (this.closed) return;
      this.abort.abort(error);
      const turn = this.turn;
      this.turn = null;
      if (turn)
        this.emit({
          type: "turn_failed",
          provider: "opencode",
          turnId: turn.id,
          error: error.message,
        });
      return undefined;
    });
    const location = { directory: this.config.cwd };
    await this.client.plugin.awaitActivation({ location }, { signal: this.abort.signal });
    if (launch?.env)
      await this.client.session.environment({ sessionID: this.id, variables: launch.env });
    for (const [server, config] of Object.entries(this.config.mcpServers ?? {})) {
      await this.client.mcp.add({
        server,
        location,
        config:
          config.type === "stdio"
            ? {
                type: "local",
                command: [config.command, ...(config.args ?? [])],
                environment: config.env,
                codemode: false,
              }
            : {
                type: "remote",
                url: config.url,
                headers: config.headers,
                oauth: false,
                codemode: false,
              },
      });
      await this.awaitMcp(server);
    }
    const system = composeSystemPromptParts(
      this.config.systemPrompt,
      this.config.daemonAppendSystemPrompt,
    );
    if (system)
      await this.client.session.instructions.entry.put({
        sessionID: this.id,
        key: "paseo",
        value: system,
      });
    this.modes = modesFromV2((await this.client.agent.list({ location })).data);
    this.timeline.messages(await messages(this.client, this.id));
    let ready!: () => void;
    let fail!: (error: unknown) => void;
    const first = new Promise<void>((resolve, reject) => {
      ready = resolve;
      fail = reject;
    });
    this.stream = this.consume(ready, fail);
    await raceProviderRefreshAbort(
      AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]),
      first,
    );
    await this.reconcileChildren(this.id);
  }
  subscribe(callback: (event: AgentStreamEvent) => void) {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
  private async awaitMcp(server: string) {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]);
    while (true) {
      const catalog = await this.client.mcp.list(
        { location: { directory: this.config.cwd } },
        { signal },
      );
      const entry = catalog.data.find((item) => item.name === server);
      if (entry?.status.status === "connected") return;
      if (entry && entry.status.status !== "pending") {
        const reason = entry.status.status === "failed" ? entry.status.error : entry.status.status;
        throw new Error(`OpenCode MCP server ${server} failed to connect: ${reason}`);
      }
      await delay(50, undefined, { signal });
    }
  }
  private emit(event: AgentStreamEvent) {
    for (const listener of this.listeners) listener(event);
  }
  private emitTimeline(event: AgentStreamEvent) {
    this.emit({ ...event, ...(this.turn ? { turnId: this.turn.id } : {}) });
  }
  async *streamHistory() {
    const history = new V2Timeline(false);
    yield* history.messages(await messages(this.client, this.id));
  }
  async getRuntimeInfo() {
    this.info = await this.client.session.get({ sessionID: this.id });
    return {
      provider: "opencode",
      sessionId: this.id,
      model: this.info.model ? `${this.info.model.providerID}/${this.info.model.id}` : null,
      modeId: this.info.agent ?? null,
      thinkingOptionId: this.info.model?.variant ?? null,
    };
  }
  async getAvailableModes() {
    return this.modes;
  }
  async getCurrentMode() {
    return this.info.agent ?? null;
  }
  async setMode(modeId: string) {
    await this.client.session.switchAgent({ sessionID: this.id, agent: modeId });
    this.info.agent = modeId;
    this.config.modeId = modeId;
    this.emit({
      type: "mode_changed",
      provider: "opencode",
      currentModeId: modeId,
      availableModes: this.modes,
    });
  }
  async setModel(model: string | null) {
    const selected = model
      ? modelRef(model, this.config.thinkingOptionId)
      : (await this.client.model.default({ location: { directory: this.config.cwd } })).data;
    if (!selected) throw new Error("OpenCode has no default model");
    await this.client.session.switchModel({
      sessionID: this.id,
      model: {
        id: selected.id,
        providerID: selected.providerID,
        variant: this.config.thinkingOptionId,
      },
    });
    this.config.model = model ?? undefined;
    this.emit({
      type: "model_changed",
      provider: "opencode",
      runtimeInfo: await this.getRuntimeInfo(),
    });
  }
  async setThinkingOption(variant: string | null) {
    const model = this.info.model;
    if (!model) throw new Error("Select an OpenCode model before changing its variant");
    await this.client.session.switchModel({
      sessionID: this.id,
      model: { id: model.id, providerID: model.providerID, ...(variant ? { variant } : {}) },
    });
    this.config.thinkingOptionId = variant ?? undefined;
    this.info = await this.client.session.get({ sessionID: this.id });
    this.emit({ type: "thinking_option_changed", provider: "opencode", thinkingOptionId: variant });
  }
  async setFeature(id: string, value: unknown) {
    if (id !== "auto_accept" || typeof value !== "boolean")
      throw new Error("Unknown OpenCode feature");
    this.config.featureValues = { ...this.config.featureValues, [id]: value };
    if (value && !this.config.toolPolicy)
      for (const request of this.pending.values())
        if (request.kind !== "question")
          await this.respondToPermission(request.id, { behavior: "allow" });
  }
  async listCommands() {
    return commands(this.client, this.config.cwd);
  }
  describePersistence(): AgentPersistenceHandle {
    return {
      provider: "opencode",
      sessionId: this.id,
      nativeHandle: this.id,
      metadata: { ...this.config },
    };
  }
  run(prompt: AgentPromptInput, options?: AgentRunOptions) {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: this.startTurn.bind(this),
      subscribe: this.subscribe.bind(this),
      getSessionId: () => this.id,
      reduceFinalText: ({ current, item }) =>
        item.type === "assistant_message" ? current + item.text : current,
    });
  }
  async startTurn(prompt: AgentPromptInput, options?: AgentRunOptions) {
    await this.stopping;
    if (this.closed) throw new Error("OpenCode session is closed");
    if (this.turn) throw new Error("OpenCode session already has an active turn");
    this.lastError = null;
    const id = randomUUID();
    const input = this.promptInput(prompt);
    let accept!: () => void;
    const submitted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const output =
      options?.outputSchema === undefined ? undefined : structuredOutput(options.outputSchema);
    const completion = this.submit(id, input, accept, options, output);
    this.turn = { id, submitted, completion, output };
    return { turnId: id };
  }
  private async submit(
    id: string,
    input: ReturnType<OpenCodeV2Session["promptInput"]>,
    accept: () => void,
    options?: AgentRunOptions,
    output?: ReturnType<typeof structuredOutput>,
  ) {
    // Defer until startTurn publishes ownership, including for immediately resolved test transports.
    await Promise.resolve();
    this.emit({ type: "turn_started", provider: "opencode", turnId: id });
    try {
      await this.dispatch(input, options, output);
      accept();
      await this.finish(id);
    } catch (error) {
      if (this.turn?.id === id) {
        this.turn = null;
        this.emit({
          type: "turn_failed",
          provider: "opencode",
          turnId: id,
          error: toDiagnosticErrorMessage(error),
        });
      }
    } finally {
      accept();
    }
  }
  private async dispatch(
    input: ReturnType<OpenCodeV2Session["promptInput"]>,
    options?: AgentRunOptions,
    output?: ReturnType<typeof structuredOutput>,
  ) {
    const command = input.text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (command?.[1] === "compact" || command?.[1] === "summarize") {
      await this.client.session.compact({ sessionID: this.id });
      return;
    }
    const selected = command
      ? (await this.listCommands()).find((item) => item.name === command[1])
      : undefined;
    if (selected && selected.kind !== "skill") {
      await this.client.session.command({
        sessionID: this.id,
        command: selected.name,
        text: command?.[2] ?? "",
        files: input.files,
      });
      return;
    }
    await this.client.session.prompt({
      sessionID: this.id,
      ...input,
      ...(selected?.kind === "skill"
        ? {
            skills: [{ id: selected.name }],
            text: command?.[2] ?? `Use the ${selected.name} skill.`,
          }
        : {}),
      metadata: {
        ...(options?.clientMessageId ? { paseoClientMessageId: options.clientMessageId } : {}),
        ...(output ? { paseoOutputSchema: output.schema } : {}),
      },
    });
  }
  private async finish(id: string) {
    await this.client.session.wait({ sessionID: this.id }, { signal: this.abort.signal });
    await this.reconcile();
    if (this.turn?.id !== id) return;
    if (this.info.outcome !== "failed" && this.info.outcome !== "interrupted")
      this.turn.output?.assert(this.history);
    const failure =
      this.info.outcome === "failed" ? (this.lastError ?? (await this.readExecutionError())) : null;
    if (this.turn?.id !== id) return;
    this.turn = null;
    if (this.info.outcome === "interrupted")
      this.emit({
        type: "turn_canceled",
        provider: "opencode",
        turnId: id,
        reason: "OpenCode interrupted execution",
      });
    else if (this.info.outcome === "failed")
      this.emit({
        type: "turn_failed",
        provider: "opencode",
        turnId: id,
        error: failure ?? "OpenCode execution failed",
      });
    else
      this.emit({
        type: "turn_completed",
        provider: "opencode",
        turnId: id,
        usage: usageFromV2(this.info),
      });
  }
  private async readExecutionError(): Promise<string> {
    let message = "OpenCode execution failed";
    for await (const event of this.client.session.log(
      { sessionID: this.id, follow: false },
      { signal: this.abort.signal },
    )) {
      if (event.type === "session.execution.failed") message = event.data.error.message;
    }
    return message;
  }
  private promptInput(prompt: AgentPromptInput) {
    if (typeof prompt === "string") return { text: prompt, files: [] };
    const text: string[] = [];
    const files: Array<{ uri: string }> = [];
    for (const part of prompt) {
      if (part.type === "text") text.push(part.text);
      else if (part.type === "image")
        files.push({ uri: `data:${part.mimeType};base64,${part.data}` });
      else text.push(renderPromptAttachmentAsText(part));
    }
    return { text: text.join("\n"), files };
  }
  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    if (this.turn?.id !== options.expectedTurnId || this.stopping) return { status: "unavailable" };
    await this.client.session.prompt({
      sessionID: this.id,
      ...this.promptInput(prompt),
      delivery: "steer",
      metadata: options.clientMessageId
        ? { paseoClientMessageId: options.clientMessageId }
        : undefined,
    });
    if (options.clearPendingPermissions)
      for (const request of this.pending.values())
        await this.respondToPermission(request.id, { behavior: "deny" });
    return { status: "accepted" };
  }
  async interrupt() {
    if (!this.stopping || this.stopFailed) {
      this.stopFailed = false;
      const turn = this.turn;
      const stop = (async () => {
        // A stop sent before the queued prompt is accepted would interrupt an idle session.
        await turn?.submitted;
        await this.client.session.interrupt({ sessionID: this.id });
        await turn?.completion;
      })();
      this.stopping = stop;
      try {
        await stop;
        this.stopping = null;
      } catch (error) {
        this.stopFailed = true;
        throw error;
      }
    } else await this.stopping;
  }
  async revertBoth(input: { messageId: string }) {
    await this.interrupt();
    await this.client.session.revert.stage({
      sessionID: this.id,
      messageID: input.messageId,
      files: true,
    });
    await this.client.session.revert.commit({ sessionID: this.id });
  }
  getPendingPermissions() {
    return [...this.pending.values()];
  }
  async respondToPermission(requestId: string, response: AgentPermissionResponse) {
    const form = this.forms.get(requestId);
    if (form) {
      if (response.behavior === "deny")
        await this.client.form.cancel({ sessionID: form.sessionID, formID: form.id });
      else {
        const raw = response.updatedInput?.answers;
        const answer: Record<string, FormValue> = {};
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error("OpenCode question response requires answers");
        for (const field of form.fields) {
          const value: unknown =
            Reflect.get(raw, field.key) ?? Reflect.get(raw, field.title ?? field.key);
          const normalized = formAnswer(field, value);
          if (normalized !== undefined) answer[field.key] = normalized;
        }
        await this.client.form.reply({ sessionID: form.sessionID, formID: form.id, answer });
      }
      this.forms.delete(requestId);
    } else {
      await this.client.permission.reply({
        sessionID: this.permissionOwners.get(requestId) ?? this.id,
        requestID: requestId,
        reply: permissionReply(response),
      });
    }
    this.resolvePending(requestId, response);
  }
  private async reconcileSnapshot() {
    const [info, history] = await Promise.all([
      this.client.session.get({ sessionID: this.id }),
      messages(this.client, this.id),
    ]);
    this.info = info;
    this.history = history;
    for (const event of this.timeline.messages(history)) this.emitTimeline(event);
    await this.reconcilePermissions(this.id);
  }
  private async reconcilePermissions(sessionID: string) {
    const [permissions, forms] = await Promise.all([
      this.client.permission.list({ sessionID }),
      this.client.form.list({ sessionID }),
    ]);
    for (const request of permissions) {
      if (this.pending.has(request.id)) continue;
      const pending: AgentPermissionRequest = {
        id: request.id,
        provider: "opencode",
        kind: "tool",
        name: request.action,
        description: request.message ?? request.resources.join("\n"),
        actions: [
          { id: "once", label: "Allow once", behavior: "allow" },
          { id: "always", label: "Always allow", behavior: "allow" },
          { id: "reject", label: "Deny", behavior: "deny" },
        ],
      };
      this.pending.set(request.id, pending);
      this.permissionOwners.set(request.id, sessionID);
      if (!this.config.toolPolicy && this.config.featureValues?.["auto_accept"] === true)
        await this.respondToPermission(request.id, { behavior: "allow" });
      else this.emit({ type: "permission_requested", provider: "opencode", request: pending });
    }
    for (const form of forms) {
      if (this.pending.has(form.id)) continue;
      const pending: AgentPermissionRequest = {
        id: form.id,
        provider: "opencode",
        name: "question",
        kind: "question",
        title: form.title,
        input: {
          questions: form.fields.map((field) => ({
            header: field.key,
            question: field.title ?? field.key,
            options: "options" in field ? field.options : undefined,
            multiple: field.type === "multiselect",
          })),
        },
      };
      this.forms.set(form.id, form);
      this.pending.set(form.id, pending);
      this.emit({ type: "permission_requested", provider: "opencode", request: pending });
    }
  }
  private async reconcile() {
    this.dirty = true;
    this.sync = this.sync.catch(() => undefined).then(() => this.drainReconciliation());
    return this.sync;
  }
  private async drainReconciliation() {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      await this.reconcileSnapshot();
    }
  }
  private async reconcileConnection() {
    await this.reconcile();
    await this.reconcileChildren(this.id);
    const active = await this.client.session.active();
    if (active[this.id]) this.observeActiveTurn();
  }
  private scheduleReconcile() {
    if (this.refreshTimer || this.closed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.reconcile().catch((error: unknown) =>
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode reconciliation failed",
        ),
      );
    }, 25);
  }
  private async reconcileChildren(parentID: string) {
    let cursor: string | undefined;
    do {
      const page = await this.client.session.list({
        ...(cursor ? { cursor } : { parentID }),
        limit: 100,
      });
      for (const child of page.data) {
        await this.reconcileChild(child);
        await this.reconcileChildren(child.id);
      }
      cursor = page.cursor.next ?? undefined;
    } while (cursor);
  }
  private async reconcileChild(info: SessionInfo) {
    await this.reconcilePermissions(info.id);
    let timeline = this.children.get(info.id);
    if (!timeline) {
      timeline = new V2Timeline();
      this.children.set(info.id, timeline);
      this.bindChild?.(info.id);
    }
    const active = await this.client.session.active();
    let status: "running" | "failed" | "canceled" | "completed" = "completed";
    if (active[info.id]) status = "running";
    else if (info.outcome === "failed") status = "failed";
    else if (info.outcome === "interrupted") status = "canceled";
    const presentation: ProviderSubagentInputEvent = {
      type: "upsert",
      id: info.id,
      parentSubagentId: info.parentID === this.id ? null : info.parentID,
      title: info.title ?? null,
      status,
      cwd: info.location.directory,
      timestamp: new Date(info.time.updated).toISOString(),
    };
    const signature = JSON.stringify(presentation);
    if (this.childStates.get(info.id) !== signature) {
      this.childStates.set(info.id, signature);
      this.emit({ type: "provider_subagent", provider: "opencode", event: presentation });
    }
    for (const event of timeline.messages(await messages(this.client, info.id))) {
      if (event.type === "timeline")
        this.emit({
          type: "provider_subagent",
          provider: "opencode",
          event: { type: "timeline", id: info.id, item: event.item, timestamp: event.timestamp },
        });
    }
  }
  private observeOwnEvent(event: import("@opencode/client").OpenCodeEvent) {
    if (event.type === "form.created" && event.data.form.sessionID === this.id) {
      this.scheduleReconcile();
      return;
    }
    if (!("sessionID" in event.data) || event.data.sessionID !== this.id) return;
    if (event.type === "permission.replied") {
      this.resolvePending(event.data.requestID, {
        behavior: event.data.reply === "reject" ? "deny" : "allow",
      });
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      this.resolvePending(event.data.id, {
        behavior: event.type === "form.cancelled" ? "deny" : "allow",
      });
    }
    if (event.type === "session.execution.failed") this.lastError = event.data.error.message;
    this.scheduleReconcile();
    if (event.type !== "session.execution.started" || this.turn) return;
    this.observeActiveTurn();
  }
  private resolvePending(requestId: string, resolution: AgentPermissionResponse) {
    if (!this.pending.delete(requestId)) return;
    this.forms.delete(requestId);
    this.permissionOwners.delete(requestId);
    this.emit({ type: "permission_resolved", provider: "opencode", requestId, resolution });
  }
  private observeActiveTurn() {
    if (this.turn) return;
    const id = randomUUID();
    const completion = Promise.resolve()
      .then(() => this.finish(id))
      .catch((error: unknown) => {
        if (this.turn?.id !== id) return;
        this.turn = null;
        this.emit({
          type: "turn_failed",
          provider: "opencode",
          turnId: id,
          error: toDiagnosticErrorMessage(error),
        });
      });
    this.turn = { id, submitted: Promise.resolve(), completion };
    this.emit({ type: "turn_started", provider: "opencode", turnId: id });
  }
  private async consume(ready: () => void, fail: (error: unknown) => void) {
    let connected = false;
    while (!this.closed && !this.abort.signal.aborted) {
      try {
        for await (const event of this.client.event.subscribe({ signal: this.abort.signal })) {
          if (this.closed || this.abort.signal.aborted) return;
          if (event.type === "server.connected") {
            await this.reconcileConnection();
            connected = true;
            ready();
          }
          if (
            event.type === "session.created" &&
            event.data.parentID &&
            (event.data.parentID === this.id || this.children.has(event.data.parentID))
          ) {
            await this.reconcileChildren(event.data.parentID);
          }
          if (
            "sessionID" in event.data &&
            typeof event.data.sessionID === "string" &&
            this.children.has(event.data.sessionID)
          ) {
            await this.reconcileChild(
              await this.client.session.get({ sessionID: event.data.sessionID }),
            );
          }
          this.observeOwnEvent(event);
        }
        if (!connected) throw new Error("OpenCode event stream ended before connecting");
      } catch (error) {
        if (this.closed || this.abort.signal.aborted) return;
        if (!connected) {
          fail(error);
          return;
        }
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode event stream interrupted; reconciling on reconnect",
        );
      }
      await delay(100, undefined, { signal: this.abort.signal }).catch(() => undefined);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await this.stream;
    await this.sync.catch(() => undefined);
    this.unbind?.();
    try {
      if (!this.persist) await this.client.session.remove({ sessionID: this.id });
    } finally {
      await this.connection.release();
    }
    this.listeners.clear();
  }
}

function permissionReply(response: AgentPermissionResponse): "reject" | "once" | "always" {
  if (response.behavior === "deny") return "reject";
  return response.selectedActionId === "always" ? "always" : "once";
}

function formAnswer(field: FormInfo["fields"][number], value: unknown): FormValue | undefined {
  if (value === undefined) return undefined;
  if (field.type === "external") return undefined;
  const labelValue = (label: string) => {
    const options = "options" in field ? field.options : undefined;
    return (
      options?.find((option) => option.value === label)?.value ??
      options?.find((option) => option.label === label)?.value ??
      label
    );
  };
  if (field.type === "multiselect") {
    if (Array.isArray(value) && value.every((item: unknown) => typeof item === "string"))
      return value.map(labelValue);
  } else if (field.type === "string" && typeof value === "string") {
    return labelValue(value);
  } else if (field.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
  } else if (field.type === "number" || field.type === "integer") {
    const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
    if (
      typeof numeric === "number" &&
      Number.isFinite(numeric) &&
      (field.type !== "integer" || Number.isInteger(numeric))
    )
      return numeric;
  }
  throw new Error(`Invalid answer for OpenCode question ${field.key}`);
}
