import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
import { applyProviderOptionsPatch } from "../../../option-controls.js";
import { assertChangesAreLive, validateProviderOptions } from "../../../provider-options.js";
import { OpenCodeProviderOptionsSchema } from "../options.js";
import { OpenCodeBackgroundInventory } from "./background-inventory.js";
import { SessionChildren } from "./children.js";
import { SessionTurns } from "./turns.js";
import { V2Timeline } from "./timeline.js";
import { waitForLocationReady, awaitPaseoPlugin } from "./readiness.js";

import type { SessionInfo, SessionMessageInfo } from "@opencode/client";

import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type {
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
import { controls } from "./configuration.js";
import { commands } from "./commands.js";
import { messages } from "./history.js";
import { SessionPermissions } from "./permissions.js";
import { SessionUsage } from "./usage.js";
import { createSessionMetricsReporter } from "../../metrics.js";
import { replayedTurnMetrics, sessionMetrics } from "./metrics.js";
import type { SessionMcp } from "./session-mcp.js";

export interface OpenCodeV2SessionOptions {
  connection: V2Connection;
  info: SessionInfo;
  config: AgentSessionConfig;
  logger: Logger;
  persist: boolean;
  requiresPaseoPlugin: boolean;
  /** The complete shell environment for this session and its descendants. */
  environment?: Record<string, string>;
  /** MCP servers Paseo hosts for this session; the session closes them. */
  mcp?: SessionMcp;
  unbind?: () => void;
  bindChild?: (id: string) => void;
  acquire?: () => Promise<V2Connection>;
  moved?: (connection: V2Connection) => void;
  historyOnly?: boolean;
}

export class OpenCodeV2Session implements AgentSession {
  readonly provider = "opencode";
  readonly capabilities = V2_CAPABILITIES;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private readonly timeline = new V2Timeline();
  private readonly abort = new AbortController();
  private readonly permissions: SessionPermissions;
  private readonly turns: SessionTurns;
  private readonly children: SessionChildren;
  private readonly usage: SessionUsage;
  private stream: Promise<void> | null = null;
  private streamAbort = new AbortController();
  private exited = false;
  private reconnecting: Promise<void> | null = null;
  private sync: Promise<void> = Promise.resolve();
  private dirty = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private history: SessionMessageInfo[] = [];
  private readonly background: OpenCodeBackgroundInventory;
  private modes: AgentMode[] = [];
  // Reconciliation runs after nearly every event; report only what changed.
  private readonly reportSessionMetrics = createSessionMetricsReporter((metrics) =>
    this.emit({ type: "session_metrics_updated", provider: "opencode", metrics }),
  );
  private connection: V2Connection;
  private info: SessionInfo;
  private readonly config: AgentSessionConfig;
  private readonly logger: Logger;
  private readonly persist: boolean;
  private readonly requiresPaseoPlugin: boolean;
  // OpenCode replaces the whole local shell environment, rather than overlaying it.
  private readonly environment: Record<string, string> | undefined;
  private readonly mcp: SessionMcp | undefined;
  private readonly unbind: (() => void) | undefined;
  private readonly acquire: (() => Promise<V2Connection>) | undefined;
  private readonly moved: ((connection: V2Connection) => void) | undefined;
  private readonly historyOnly: boolean;
  constructor(options: OpenCodeV2SessionOptions) {
    const { info, config, bindChild } = options;
    this.connection = options.connection;
    this.info = info;
    this.config = config;
    this.logger = options.logger;
    this.persist = options.persist;
    this.requiresPaseoPlugin = options.requiresPaseoPlugin;
    this.environment = options.environment;
    this.mcp = options.mcp;
    this.unbind = options.unbind;
    this.acquire = options.acquire;
    this.moved = options.moved;
    this.historyOnly = options.historyOnly ?? false;
    this.background = new OpenCodeBackgroundInventory({
      id: info.id,
      cwd: config.cwd,
      emit: (event) => this.emit(event),
      report: (error) =>
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode background inventory failed",
        ),
    });
    this.permissions = new SessionPermissions(
      () => this.client,
      info.id,
      config,
      (event) => this.emit(event),
    );
    this.children = new SessionChildren({
      client: () => this.client,
      id: info.id,
      emit: (event) => this.emit(event),
      reconcilePermissions: (id) => this.permissions.reconcile(id),
      adoptChild: async (id) => {
        bindChild?.(id);
        await this.adoptDescendant(id);
      },
    });
    this.turns = new SessionTurns({
      client: () => this.client,
      id: info.id,
      cwd: config.cwd,
      signal: this.abort.signal,
      emit: (event) => this.emit(event),
      reconcile: async () => {
        await this.reconcile();
        return { info: this.info, history: this.history };
      },
      reportReconciliationError: (error) =>
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode turn reconciliation failed; retrying",
        ),
      clearPermissions: async () => {
        for (const request of this.permissions.list())
          await this.permissions.respondToPermission(request.id, {
            behavior: "deny",
            message:
              "The user answered with a message instead of approving. Their message follows.",
          });
      },
    });
    this.usage = new SessionUsage({
      client: () => this.client,
      cwd: config.cwd,
      info: () => this.info,
      emit: (event) => this.emit(event),
      reportError: (error) =>
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode context usage update failed",
        ),
    });
  }
  get id() {
    return this.info.id;
  }
  get controls() {
    return controls;
  }
  private get client() {
    return this.connection.client;
  }
  async initialize() {
    this.watchExit(this.connection);
    await this.configureConnection();
    const location = { directory: this.config.cwd };
    this.modes = modesFromV2((await this.client.agent.list({ location })).data);
    await this.timeline.messages(await messages(this.client, this.id), () => {});
    await this.startStream();
    await this.children.reconcile(this.id);
  }
  private watchExit(connection: V2Connection) {
    void connection.exited.then((error) => {
      if (this.closed || this.connection !== connection) return undefined;
      this.exited = true;
      this.background.disconnect(true);
      this.streamAbort.abort(error);
      this.turns.fail(error);
      return undefined;
    });
  }
  private async configureConnection() {
    const location = { directory: this.config.cwd };
    await this.connection.bindSession(this.id, this.config.cwd);
    await waitForLocationReady({ client: this.client, location, signal: this.abort.signal });
    if (this.requiresPaseoPlugin)
      await awaitPaseoPlugin({ client: this.client, location, signal: this.abort.signal });
    if (this.historyOnly) return;
    const system = composeSystemPromptParts(
      this.config.systemPrompt,
      this.config.daemonAppendSystemPrompt,
      ...(this.config.pluginAppendSystemPrompt ?? []),
    );
    if (system) {
      await this.client.session.instructions.entry.put({
        sessionID: this.id,
        key: "paseo",
        value: system,
      });
    } else {
      const entries = await this.client.session.instructions.entry.list({ sessionID: this.id });
      if (entries.some((entry) => entry.key === "paseo")) {
        await this.client.session.instructions.entry.remove({ sessionID: this.id, key: "paseo" });
      }
    }
  }
  /** Gives a descendant session the shell environment, which OpenCode does not inherit. */
  async adoptDescendant(sessionID: string) {
    if (this.closed || this.historyOnly || !this.environment) return;
    await this.client.session.environment({ sessionID, variables: this.environment });
  }
  private async startStream() {
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
  }
  private async reconnectIfExited() {
    if (this.closed) throw new Error("OpenCode session is closed");
    if (!this.exited) return;
    this.reconnecting ??= this.reconnect().finally(() => {
      this.reconnecting = null;
    });
    await this.reconnecting;
  }
  private async reconnect() {
    if (!this.acquire) throw new Error("OpenCode helper server exited");
    await this.stream;
    await this.sync.catch(() => undefined);
    await this.connection
      .unbindSession(this.id, this.config.cwd)
      .catch((error: unknown) =>
        this.logger.warn({ error }, "Could not unbind the OpenCode Paseo bridge"),
      );
    const next = await this.acquire();
    if (this.closed) {
      await next.release();
      throw new Error("OpenCode session is closed");
    }
    const old = this.connection;
    this.connection = next;
    this.streamAbort = new AbortController();
    this.exited = false;
    this.watchExit(next);
    try {
      await this.configureConnection();
      await this.startStream();
    } catch (error) {
      this.connection = old;
      this.exited = true;
      this.streamAbort.abort();
      await next.release();
      throw error;
    }
    this.moved?.(next);
    await old.release();
  }
  subscribe(callback: (event: AgentStreamEvent) => void) {
    this.listeners.add(callback);
    const background = this.background.snapshot();
    if (background) callback(background);
    // Reopening can adopt an execution during initialization, before its caller
    // can subscribe. Deliver that live turn so it remains visible and interruptible.
    if (this.turns.id)
      callback({ type: "turn_started", provider: "opencode", turnId: this.turns.id });
    return () => {
      this.listeners.delete(callback);
    };
  }
  private emit(event: AgentStreamEvent) {
    for (const listener of this.listeners) listener(event);
  }
  private emitTimeline(event: AgentStreamEvent) {
    this.emit({ ...event, ...(this.turns.id ? { turnId: this.turns.id } : {}) });
  }
  async *streamHistory() {
    await this.reconnectIfExited();
    const history = new V2Timeline(false);
    const events: AgentStreamEvent[] = [];
    const [info, list] = await Promise.all([
      // Session totals are extra; history replays without them.
      this.client.session.get({ sessionID: this.id }).catch((error: unknown) => {
        this.logger.debug({ err: error }, "OpenCode session info unavailable for history");
        return null;
      }),
      messages(this.client, this.id),
    ]);
    const turnMetrics = replayedTurnMetrics(list);
    await history.messages(
      list,
      (event) => {
        events.push(event);
      },
      (message) => {
        const metrics = turnMetrics.get(message.id);
        if (metrics) events.push({ type: "turn_completed", provider: "opencode", metrics });
      },
    );
    const metrics = info ? sessionMetrics(info, list) : [];
    if (metrics.length > 0) {
      events.push({ type: "session_metrics_updated", provider: "opencode", metrics });
    }
    yield* events;
  }
  async getRuntimeInfo() {
    await this.reconnectIfExited();
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
    await this.reconnectIfExited();
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
    await this.reconnectIfExited();
    const location = { directory: this.config.cwd };
    const selected = model ? modelRef(model) : (await this.client.model.default({ location })).data;
    if (!selected) throw new Error("OpenCode has no default model");
    const catalog = await this.client.model.list({ location });
    const target = catalog.data.find(
      (entry) =>
        entry.enabled && entry.providerID === selected.providerID && entry.id === selected.id,
    );
    if (!target)
      throw new Error(`OpenCode model unavailable: ${selected.providerID}/${selected.id}`);
    const retainedVariant = this.config.thinkingOptionId;
    const variant =
      retainedVariant !== "default" && target.variants.some((entry) => entry.id === retainedVariant)
        ? retainedVariant
        : undefined;
    const nextModel = {
      id: selected.id,
      providerID: selected.providerID,
      ...(variant ? { variant } : {}),
    };
    await this.client.session.switchModel({ sessionID: this.id, model: nextModel });
    this.info.model = nextModel;
    this.config.model = model ?? undefined;
    this.config.thinkingOptionId = variant;
    this.emit({
      type: "thinking_option_changed",
      provider: "opencode",
      thinkingOptionId: variant ?? null,
    });
    this.emit({
      type: "model_changed",
      provider: "opencode",
      runtimeInfo: {
        provider: "opencode",
        sessionId: this.id,
        model: `${selected.providerID}/${selected.id}`,
        modeId: this.info.agent ?? null,
        thinkingOptionId: variant ?? null,
      },
    });
    return { model: `${selected.providerID}/${selected.id}` };
  }

  async setThinkingOption(variant: string | null) {
    await this.reconnectIfExited();
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
  /** The agent manager sends one apply at a time, so a failed one restores exactly what it changed. */
  async applyOptions(options: ProviderOptions): Promise<void> {
    assertChangesAreLive({
      provider: "opencode",
      patch: options,
      current: this.config.providerOptions,
      live: ["auto_accept"],
    });
    const next = validateProviderOptions(
      "opencode",
      OpenCodeProviderOptionsSchema,
      applyProviderOptionsPatch({ options: this.config.providerOptions, patch: options }),
    );
    if (!("auto_accept" in options)) return;
    const value = next?.auto_accept === true;
    const previous = this.config.providerOptions;
    this.config.providerOptions = { ...previous, auto_accept: value };
    try {
      if (value && !this.config.toolPolicy)
        for (const request of this.permissions.list())
          if (request.kind !== "question")
            await this.respondToPermission(request.id, { behavior: "allow" });
    } catch (error) {
      // A rejected apply stores nothing, so the running session keeps asking as it did.
      this.config.providerOptions = previous;
      throw error;
    }
  }
  async listCommands() {
    await this.reconnectIfExited();
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
    await this.reconnectIfExited();
    await this.connection.bindSession(this.id, this.config.cwd);
    return this.turns.startTurn(prompt, options);
  }
  steerActiveTurn(prompt: AgentPromptInput, options: SteerActiveTurnOptions): Promise<SteerResult> {
    return this.turns.steerActiveTurn(prompt, options);
  }
  stopBackgroundWork(id: string) {
    return this.background.stopItem(id);
  }
  interrupt() {
    return this.turns.interrupt();
  }
  async revertBoth(input: { messageId: string }) {
    await this.interrupt();
    await this.reconnectIfExited();
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
    await this.reconnectIfExited();
    const deniesOwnRequest =
      response.behavior === "deny" && this.permissions.isOwnedBy(requestId, this.id);
    await this.permissions.respondToPermission(requestId, response);
    if (deniesOwnRequest) this.turns.requestDenied();
  }
  private async reconcileSnapshot() {
    const [info, history] = await Promise.all([
      this.client.session.get({ sessionID: this.id }),
      messages(this.client, this.id),
    ]);
    this.info = info;
    this.history = history;
    await this.timeline.messages(history, (event) => this.emitTimeline(event));
    this.reportSessionMetrics(sessionMetrics(this.info, this.history));
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
    await this.connection.bindSession(this.id, this.config.cwd);
    // Session environments are process-local. Reapply this agent's snapshot before
    // reconciling a new connection, including event-stream reconnections.
    if (this.environment)
      await this.client.session.environment({ sessionID: this.id, variables: this.environment });
    await this.children.restoreAdoptions();
    await this.reconcile();
    await this.children.reconcile(this.id);
    await this.turns.reconcile();
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
    this.usage.observe(event);
    this.turns.observe(event);
    this.scheduleReconcile();
  }
  private async consume(ready: () => void, fail: (error: unknown) => void) {
    const signal = AbortSignal.any([this.abort.signal, this.streamAbort.signal]);
    let connected = false;
    while (!this.closed && !signal.aborted) {
      try {
        for await (const event of this.client.event.subscribe({ signal })) {
          if (this.closed || signal.aborted) return;
          if (event.type === "server.connected") {
            this.timeline.resetStreams();
            await this.reconcileConnection();
            signal.throwIfAborted();
            this.background.start(this.client);
            connected = true;
            ready();
          }
          this.background.observe(event);
          await this.children.observe(event);
          this.observeOwnEvent(event);
        }
        if (!connected) throw new Error("OpenCode event stream ended before connecting");
      } catch (error) {
        if (this.closed || signal.aborted) return;
        if (!connected) {
          fail(error);
          return;
        }
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode event stream interrupted; reconciling on reconnect",
        );
      }
      this.background.disconnect();
      await delay(100, undefined, { signal }).catch(() => undefined);
    }
  }
  async canStopRuntime(): Promise<boolean> {
    if (this.closed || this.exited || this.reconnecting || this.turns.id || this.dirty)
      return false;
    const request = { signal: AbortSignal.timeout(10_000) };
    // Active executions are server-wide. Releasing the last lease must not stop an
    // autonomous execution merely because it belongs to another session or location.
    if (Object.keys(await this.client.session.active(request)).length > 0) return false;
    const family = new Map([[this.info.id, this.info]]);
    const directories = new Set<string>();
    for (const info of family.values()) {
      if ((await this.client.session.inbox.list({ sessionID: info.id }, request)).length)
        return false;
      directories.add(info.location.directory);
      let cursor: string | undefined;
      do {
        const page = await this.client.session.list(
          { ...(cursor ? { cursor } : { parentID: info.id }), limit: 100 },
          request,
        );
        for (const child of page.data) family.set(child.id, child);
        cursor = page.cursor.next ?? undefined;
      } while (cursor);
    }
    for (const directory of directories) {
      const shells = await this.client.shell.list({ location: { directory } }, request);
      if (shells.data.some((shell) => shell.status === "running")) return false;
    }
    return !this.turns.id && !this.dirty;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.turns.close();
    this.streamAbort.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.background.disconnect();
    await this.stream;
    await this.reconnecting?.catch(() => undefined);
    await this.sync.catch(() => undefined);
    await this.connection
      .unbindSession(this.id, this.config.cwd)
      .catch((error: unknown) =>
        this.logger.warn({ error }, "Could not unbind the OpenCode Paseo bridge"),
      );
    this.unbind?.();
    try {
      if (!this.persist) await this.client.session.remove({ sessionID: this.id });
    } finally {
      await this.mcp?.close();
      await this.connection.release();
    }
    this.listeners.clear();
  }
}
