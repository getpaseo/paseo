import { SessionChildren } from "./children.js";
import { SessionTurns } from "./turns.js";
import { V2Timeline } from "./timeline.js";
import { waitForLocationReady, awaitPaseoPlugin } from "./readiness.js";

import type { SessionInfo, SessionMessageInfo } from "@opencode/client";

import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type {
  AgentLaunchContext,
  AgentMode,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  SteerActiveTurnOptions,
  SteerResult,
} from "../../../agent-sdk-types.js";

import { toDiagnosticErrorMessage } from "../../diagnostic-utils.js";

import { runProviderTurn } from "../../provider-runner.js";

import { composeSystemPromptParts } from "../../../system-prompt.js";
import { raceProviderRefreshAbort } from "../../../provider-refresh-deadline.js";

import { type V2Connection } from "./runtime.js";
import { modelRef, modesFromV2 } from "./mapping.js";

import { V2_CAPABILITIES } from "./capabilities.js";
import { features } from "./configuration.js";
import { commands } from "./commands.js";
import { messages } from "./history.js";
import { SessionPermissions } from "./permissions.js";
export class OpenCodeV2Session implements AgentSession {
  readonly provider = "opencode";
  readonly capabilities = V2_CAPABILITIES;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private readonly timeline = new V2Timeline();
  private readonly abort = new AbortController();
  private readonly permissions: SessionPermissions;
  private readonly turns: SessionTurns;
  private readonly children: SessionChildren;
  private stream: Promise<void> | null = null;
  private sync: Promise<void> = Promise.resolve();
  private dirty = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private history: SessionMessageInfo[] = [];
  private modes: AgentMode[] = [];
  constructor(
    private readonly connection: V2Connection,
    private info: SessionInfo,
    private readonly config: AgentSessionConfig,
    private readonly logger: Logger,
    private readonly persist: boolean,
    private readonly requiresPaseoPlugin: boolean,
    private readonly unbind?: () => void,
    bindChild?: (id: string) => void,
  ) {
    this.permissions = new SessionPermissions(connection.client, info.id, config, (event) =>
      this.emit(event),
    );
    this.children = new SessionChildren({
      client: connection.client,
      id: info.id,
      emit: (event) => this.emit(event),
      reconcilePermissions: (id) => this.permissions.reconcile(id),
      bindChild,
    });
    this.turns = new SessionTurns({
      client: connection.client,
      id: info.id,
      cwd: config.cwd,
      signal: this.abort.signal,
      emit: (event) => this.emit(event),
      reconcile: async () => {
        await this.reconcile();
        return { info: this.info, history: this.history };
      },
      clearPermissions: async () => {
        for (const request of this.permissions.list())
          await this.permissions.respondToPermission(request.id, { behavior: "deny" });
      },
    });
  }
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
      this.turns.fail(error);
      return undefined;
    });
    const location = { directory: this.config.cwd };
    await waitForLocationReady({ client: this.client, location, signal: this.abort.signal });
    if (this.requiresPaseoPlugin)
      await awaitPaseoPlugin({ client: this.client, location, signal: this.abort.signal });
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
    await this.children.reconcile(this.id);
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
    this.emit({ ...event, ...(this.turns.id ? { turnId: this.turns.id } : {}) });
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
      for (const request of this.permissions.list())
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
  startTurn(prompt: AgentPromptInput, options?: AgentRunOptions) {
    return this.turns.startTurn(prompt, options);
  }
  steerActiveTurn(prompt: AgentPromptInput, options: SteerActiveTurnOptions): Promise<SteerResult> {
    return this.turns.steerActiveTurn(prompt, options);
  }
  interrupt() {
    return this.turns.interrupt();
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
    return [...this.permissions.list()];
  }
  async respondToPermission(requestId: string, response: AgentPermissionResponse) {
    await this.permissions.respondToPermission(requestId, response);
  }
  private async reconcileSnapshot() {
    const [info, history] = await Promise.all([
      this.client.session.get({ sessionID: this.id }),
      messages(this.client, this.id),
    ]);
    this.info = info;
    this.history = history;
    for (const event of this.timeline.messages(history)) this.emitTimeline(event);
    await this.permissions.reconcile(this.id);
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
    await this.children.reconcile(this.id);
    const active = await this.client.session.active();
    if (active[this.id]) this.turns.observeActiveTurn();
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
  private observeOwnEvent(event: import("@opencode/client").OpenCodeEvent) {
    if (event.type === "form.created" && event.data.form.sessionID === this.id) {
      this.scheduleReconcile();
      return;
    }
    if (!("sessionID" in event.data) || event.data.sessionID !== this.id) return;
    if (event.type === "session.text.started" || event.type === "session.reasoning.started") {
      if (event.type === "session.text.started" && this.turns.hasStructuredOutput) return;
      this.timeline.startPart({
        ...event.data,
        type: event.type === "session.text.started" ? "text" : "reasoning",
      });
      return;
    }
    if (event.type === "session.text.delta" || event.type === "session.reasoning.delta") {
      const isText = event.type === "session.text.delta";
      // A structured-output turn supplies its answer through a tool, so streamed
      // prose is not part of the result and must not reach the timeline.
      if (isText && this.turns.hasStructuredOutput) return;
      const streamed = this.timeline.delta({
        assistantMessageID: event.data.assistantMessageID,
        ordinal: event.data.ordinal,
        delta: event.data.delta,
        type: isText ? "text" : "reasoning",
      });
      if (streamed) this.emitTimeline(streamed);
      return;
    }
    this.permissions.observe(event);
    if (event.type === "session.execution.failed")
      this.turns.executionError = event.data.error.message;
    this.scheduleReconcile();
    if (event.type !== "session.execution.started" || this.turns.id) return;
    this.turns.observeActiveTurn();
  }
  private async consume(ready: () => void, fail: (error: unknown) => void) {
    let connected = false;
    while (!this.closed && !this.abort.signal.aborted) {
      try {
        for await (const event of this.client.event.subscribe({ signal: this.abort.signal })) {
          if (this.closed || this.abort.signal.aborted) return;
          if (event.type === "server.connected") {
            this.timeline.resetStreams();
            await this.reconcileConnection();
            connected = true;
            ready();
          }
          await this.children.observe(event);
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
