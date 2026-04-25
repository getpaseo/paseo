// Hubcode agent — proxies chat completions through the Hubcode backend.
//
// Credentials are fetched from the auth-server on session creation using the
// session token forwarded by the client (desktop/web/mobile). The backend
// URL and per-user API key returned by `GET /api/me/hubcode-models` are
// used to call `/v1/chat/completions` with the combo name as model.
//
// Capabilities:
//   - Streaming text via SSE (assistant_message accumulation).
//   - MCP tool loop: tools auto-discovered from session.mcpServers, exposed
//     to the LLM in OpenAI tools[] schema, executed locally, results fed
//     back as role:tool messages until the model stops requesting tools.
//   - Tool approval via approvalPolicy="ask" (permission_requested events).
//   - System prompt + skills/memory/reasoning passed through to backend.
//   - Cancellation via AbortController.
//
// Out of scope:
//   - Voice / dynamic modes / parallel tool execution.

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  ListModelsOptions,
  ListModesOptions,
} from "../agent-sdk-types.js";
import { randomUUID } from "node:crypto";
import { HubcodeMcpRuntime, type OpenAiTool } from "./hubcode-mcp-runtime.js";
import { AGENT_PROVIDER_DEFINITIONS } from "../provider-manifest.js";
import { isReadOnlyTool } from "./tool-safety.js";
import { loadHubcodeSession, saveHubcodeSession } from "./hubcode-session-store.js";

const DEFAULT_AUTH_URL = process.env.HUBCODE_AUTH_SERVER_URL || "http://localhost:3002";
const MAX_TOOL_LOOP_ITERATIONS = 10;

/**
 * Modes mirror Claude's permission tiers so users get the same mental model.
 * Behavior summary:
 *   - "default"           → ask before every tool call (uses approval flow)
 *   - "acceptEdits"       → auto-approve, normal tool execution
 *   - "plan"              → auto-approve BUT a system prompt forbids
 *                            modifying tools (best we can do without a
 *                            read/write tool taxonomy on MCP)
 *   - "bypassPermissions" → auto-approve, no warnings
 */
const HUBCODE_MODE_IDS = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
type HubcodeModeId = (typeof HUBCODE_MODE_IDS)[number];
function isHubcodeMode(value: string): value is HubcodeModeId {
  return (HUBCODE_MODE_IDS as readonly string[]).includes(value);
}
const PLAN_MODE_PREAMBLE =
  "You are in PLAN MODE. Do NOT call any tool that writes files, runs shell " +
  "commands, mutates state, or changes anything outside of read-only inspection. " +
  "Use read-only tools (search, list, read) and your reasoning to produce a " +
  "step-by-step plan, then ask the user to approve switching out of plan mode " +
  "before executing it.";

function getHubcodeModesFromManifest(): AgentMode[] {
  const def = AGENT_PROVIDER_DEFINITIONS.find((d) => d.id === "hubcode");
  return (def?.modes ?? []).map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
    icon: m.icon,
    colorTier: m.colorTier,
  }));
}

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};

interface HubcodeModelsBundle {
  requiresUpgrade: boolean;
  planId: string;
  apiKey: string | null;
  baseUrl: string;
  combos: { comboId: string; comboName: string }[];
}

interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

interface ClientDeps {
  fetch?: FetchLike;
  logger?: Logger;
  now?: () => Date;
  authServerUrl?: string;
}

class HubcodeUpgradeRequiredError extends Error {
  constructor(message = "Hubcode combos are available on Pro and Enterprise plans.") {
    super(message);
    this.name = "HubcodeUpgradeRequiredError";
  }
}

class HubcodeAgentClient implements AgentClient {
  readonly provider: AgentProvider = "hubcode";
  readonly capabilities = CAPABILITIES;

  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly authServerUrl: string;

  constructor(deps: ClientDeps = {}) {
    this.fetchImpl = deps.fetch ?? ((u, i) => fetch(u, i));
    this.logger = deps.logger ?? console;
    this.authServerUrl = deps.authServerUrl ?? DEFAULT_AUTH_URL;
  }

  async isAvailable(): Promise<boolean> {
    // Availability is resolved lazily — listing models requires a session
    // token we don't have here. Report true so the picker shows Hubcode;
    // per-user gating happens on listModels() / createSession().
    return true;
  }

  async listModels(options?: ListModelsOptions): Promise<AgentModelDefinition[]> {
    const token = readTokenFromEnv(options?.cwd ?? null);
    if (!token) return [];
    try {
      const bundle = await this.fetchBundle(token);
      if (bundle.requiresUpgrade) {
        return [
          {
            id: "__upgrade__",
            label: "Upgrade to Pro to use Hubcode",
            isDefault: false,
          } as AgentModelDefinition,
        ];
      }
      return bundle.combos.map(
        (c) =>
          ({
            id: c.comboName,
            label: c.comboName,
            isDefault: false,
          }) as AgentModelDefinition,
      );
    } catch (err) {
      this.logger.warn?.("[hubcode] listModels failed:", (err as Error).message);
      return [];
    }
  }

  async listModes(_options?: ListModesOptions): Promise<AgentMode[]> {
    return getHubcodeModesFromManifest();
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const token = launchContext?.env?.HUBCODE_SESSION_TOKEN ?? readTokenFromEnv(config.cwd);
    if (!token) {
      throw new Error("Missing Hubcode session token — sign in before selecting a Hubcode combo.");
    }

    const overrideAuthUrl = launchContext?.env?.HUBCODE_AUTH_SERVER_URL;
    const bundle = await this.fetchBundle(token, overrideAuthUrl);
    if (bundle.requiresUpgrade) {
      throw new HubcodeUpgradeRequiredError();
    }
    if (!bundle.apiKey) {
      throw new Error("Hubcode account is missing an API key — try signing in again.");
    }
    const comboName =
      config.model ??
      bundle.combos[0]?.comboName ??
      (() => {
        throw new Error("No Hubcode combo available for this plan.");
      })();

    const mcpRuntime = config.mcpServers
      ? new HubcodeMcpRuntime({ servers: config.mcpServers, logger: this.logger })
      : null;

    return new HubcodeAgentSession({
      config,
      model: comboName,
      baseUrl: bundle.baseUrl,
      apiKey: bundle.apiKey,
      fetchImpl: this.fetchImpl,
      logger: this.logger,
      mcpRuntime,
    });
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    // The session id is the file id on disk. If the record is missing
    // (e.g. user wiped $HUBCODE_HOME) we fall through to a fresh session
    // rather than fail outright — the agent reappears, just empty.
    const persisted = await loadHubcodeSession(handle.sessionId).catch((err) => {
      this.logger.warn?.(
        `[hubcode] failed to load persisted session ${handle.sessionId}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    });

    const config: AgentSessionConfig = {
      ...(overrides as AgentSessionConfig),
      provider: "hubcode",
    };
    const token = launchContext?.env?.HUBCODE_SESSION_TOKEN ?? readTokenFromEnv(config.cwd);
    if (!token) {
      throw new Error("Missing Hubcode session token — sign in before resuming a Hubcode chat.");
    }
    const overrideAuthUrl = launchContext?.env?.HUBCODE_AUTH_SERVER_URL;
    const bundle = await this.fetchBundle(token, overrideAuthUrl);
    if (bundle.requiresUpgrade) {
      throw new HubcodeUpgradeRequiredError();
    }
    if (!bundle.apiKey) {
      throw new Error("Hubcode account is missing an API key — try signing in again.");
    }
    const comboName =
      config.model ??
      persisted?.model ??
      bundle.combos[0]?.comboName ??
      (() => {
        throw new Error("No Hubcode combo available for this plan.");
      })();

    const mcpRuntime = config.mcpServers
      ? new HubcodeMcpRuntime({ servers: config.mcpServers, logger: this.logger })
      : null;

    return new HubcodeAgentSession({
      config,
      model: comboName,
      baseUrl: bundle.baseUrl,
      apiKey: bundle.apiKey,
      fetchImpl: this.fetchImpl,
      logger: this.logger,
      mcpRuntime,
      sessionId: handle.sessionId,
      // The on-disk shape matches `ChatMessage` (we wrote it ourselves);
      // the runtime cast is safe because `loadHubcodeSession` validated
      // that `messages` is an array.
      restoredMessages: (persisted?.messages as ChatMessage[] | undefined) ?? [],
      restoredMode:
        persisted?.modeId && isHubcodeMode(persisted.modeId) ? persisted.modeId : undefined,
    });
  }

  private async fetchBundle(
    token: string,
    authServerUrlOverride?: string | null,
  ): Promise<HubcodeModelsBundle> {
    const url = `${authServerUrlOverride || this.authServerUrl}/api/me/hubcode-models`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`hubcode auth ${res.status}: ${await safeText(res)}`);
    }
    return (await res.json()) as HubcodeModelsBundle;
  }
}

function readTokenFromEnv(_cwd: string | null): string | null {
  return process.env.HUBCODE_SESSION_TOKEN ?? null;
}

interface SessionDeps {
  config: AgentSessionConfig;
  model: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl: FetchLike;
  logger: Logger;
  mcpRuntime?: HubcodeMcpRuntime | null;
  /**
   * When present, identifies a previously persisted conversation. New
   * sessions get a fresh uuid; resumed sessions reuse the disk record's id.
   */
  sessionId?: string;
  /** Pre-loaded conversation history (used by `resumeSession`). */
  restoredMessages?: ChatMessage[];
  /** Pre-loaded permission/behavior mode (used by `resumeSession`). */
  restoredMode?: HubcodeModeId;
}

/** Conversation message accepted by OpenAI chat/completions. */
type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

interface PendingToolCall {
  id: string;
  name: string;
  argumentsBuffer: string;
}

class HubcodeAgentSession implements AgentSession {
  readonly provider: AgentProvider = "hubcode";
  readonly capabilities = CAPABILITIES;
  readonly id: string;

  private readonly config: AgentSessionConfig;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly history: AgentStreamEvent[] = [];
  private readonly messages: ChatMessage[] = [];
  private readonly mcpRuntime: HubcodeMcpRuntime | null;
  private cachedTools: OpenAiTool[] | null = null;
  private activeController: AbortController | null = null;
  /**
   * Promise that resolves when the in-flight `runTurn` settles (completes,
   * cancels, or fails). Tracked so `startTurn` can abort + await before
   * mutating `this.messages` for the next turn — otherwise an interrupted
   * tool execution can still push a `role: "tool"` reply AFTER the new user
   * message, breaking the conversation history.
   */
  private activeRunPromise: Promise<void> | null = null;
  private turnCounter = 0;
  /**
   * Current permission/behavior mode. Seeded from `config.modeId` and
   * mutated by `setMode` (see also `provider-manifest.ts:HUBCODE_MODES`).
   * Drives both `askApproval` and the plan-mode system-prompt preamble.
   */
  private currentMode: HubcodeModeId = "default";
  /** Tool-call approvals waiting on `respondToPermission`. */
  private readonly pendingPermissions = new Map<
    string,
    {
      request: AgentPermissionRequest;
      resolve: (response: AgentPermissionResponse) => void;
    }
  >();

  constructor(deps: SessionDeps) {
    this.config = deps.config;
    this.model = deps.model;
    this.baseUrl = deps.baseUrl;
    this.apiKey = deps.apiKey;
    this.fetchImpl = deps.fetchImpl;
    this.logger = deps.logger;
    this.mcpRuntime = deps.mcpRuntime ?? null;
    this.id = deps.sessionId ?? randomUUID();
    if (deps.restoredMessages && deps.restoredMessages.length > 0) {
      this.messages.push(...deps.restoredMessages);
    }
    // Restore order: explicit dep wins over config (so a resumed session
    // keeps the mode it was using even if the user later changed the
    // default in their config).
    if (deps.restoredMode && isHubcodeMode(deps.restoredMode)) {
      this.currentMode = deps.restoredMode;
    } else if (deps.config.modeId && isHubcodeMode(deps.config.modeId)) {
      this.currentMode = deps.config.modeId;
    }
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    for (const event of this.history) yield event;
  }

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.model,
      thinkingOptionId: null,
      modeId: this.currentMode,
    };
  }
  async getAvailableModes(): Promise<AgentMode[]> {
    return getHubcodeModesFromManifest();
  }
  async getCurrentMode() {
    return this.currentMode;
  }
  async setMode(modeId: string): Promise<void> {
    if (!isHubcodeMode(modeId)) {
      throw new Error(`Unknown hubcode mode: ${modeId}`);
    }
    if (this.currentMode === modeId) return;
    this.currentMode = modeId;
    this.persist();
    // The UI picks up the new mode via the next `getRuntimeInfo` round-trip
    // (same flow as claude-agent), so we don't need a dedicated stream event.
  }
  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values()).map((p) => p.request);
  }
  async respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    pending.resolve(response);
    this.emit({
      type: "permission_resolved",
      provider: this.provider,
      requestId,
      resolution: response,
    });
  }
  describePersistence(): AgentPersistenceHandle | null {
    // The handle just *points* to the on-disk record (`<sessionId>.json`);
    // the messages themselves live in the file written by `persist()`.
    return {
      provider: this.provider,
      sessionId: this.id,
      nativeHandle: this.id,
    };
  }

  /**
   * Best-effort write of the current conversation to disk. Called after each
   * settled turn and after `setMode`. Failures are logged but never thrown —
   * losing one save is recoverable, losing the next turn because we crashed
   * the agent on a disk error is not.
   */
  private persist(): void {
    void saveHubcodeSession({
      sessionId: this.id,
      modeId: this.currentMode,
      model: this.model,
      messages: this.messages,
    }).catch((err) => {
      this.logger.warn?.(
        `[hubcode] failed to persist session ${this.id}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
  async setModel(modelId: string | null): Promise<void> {
    if (modelId) Object.assign(this, { model: modelId });
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    await this.startTurn(prompt, options);
    // startTurn currently kicks off the HTTP request asynchronously; wait
    // for either turn_completed or turn_failed before returning.
    await new Promise<void>((resolve) => {
      const unsubscribe = this.subscribe((ev) => {
        if (
          ev.type === "turn_completed" ||
          ev.type === "turn_failed" ||
          ev.type === "turn_canceled"
        ) {
          unsubscribe();
          resolve();
        }
      });
    });
    const last = this.history[this.history.length - 1];
    const canceled = last?.type === "turn_canceled";
    const finalMessage = [...this.history]
      .reverse()
      .find((e) => e.type === "timeline" && e.item.type === "assistant_message");
    const finalText =
      finalMessage &&
      finalMessage.type === "timeline" &&
      finalMessage.item.type === "assistant_message"
        ? finalMessage.item.text
        : "";
    return {
      sessionId: this.id ?? "",
      finalText,
      timeline: this.history
        .filter((e): e is Extract<AgentStreamEvent, { type: "timeline" }> => e.type === "timeline")
        .map((e) => e.item),
      canceled,
    };
  }

  async startTurn(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    // If a previous turn is still in flight, abort it and wait for the run
    // loop to fully settle. Without this, an interrupted tool execution
    // can keep running (mcpRuntime.invoke isn't signal-aware) and push a
    // late `role: "tool"` reply AFTER the new user message — which breaks
    // the openai→anthropic translation in OmniRoute and yields a 400
    // "each tool_use must have a single result". The await is bounded:
    // runTurn either returns on AbortError, completes normally, or throws.
    if (this.activeController) {
      this.activeController.abort();
    }
    if (this.activeRunPromise) {
      try {
        await this.activeRunPromise;
      } catch {
        // Swallow — the previous run's failure was already emitted.
      }
    }

    this.turnCounter += 1;
    const turnId = `hubcode-${this.turnCounter}`;
    const controller = new AbortController();
    this.activeController = controller;

    // If the prior turn was cancelled mid-tool-execution before pushing
    // its `role: "tool"` reply, the assistant message with `tool_calls`
    // sits in `this.messages` without a partner. OmniRoute's
    // openai→anthropic translator would insert a synthetic tool_result
    // for the missing pair, breaking later turns. Backfill synthetic
    // `[interrupted by user]` replies so the conversation is always
    // balanced before we push the new user input.
    this.backfillMissingToolResults();

    const userText = typeof prompt === "string" ? prompt : promptToText(prompt);
    this.messages.push({ role: "user", content: userText });
    this.emit({ type: "turn_started", provider: this.provider, turnId });
    // We intentionally do NOT emit a `user_message` timeline item — the chat
    // UI already renders the user's bubble from the input area as soon as
    // they hit send. Re-emitting here would duplicate the bubble.

    // Run the HTTP + SSE in the background so startTurn can return promptly.
    const runPromise = this.runTurn(controller, turnId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "turn_failed", provider: this.provider, turnId, error: message });
    });
    this.activeRunPromise = runPromise;
    void runPromise.finally(() => {
      // Only clear if no newer turn has overwritten it.
      if (this.activeRunPromise === runPromise) {
        this.activeRunPromise = null;
      }
    });
    return { turnId };
  }

  async interrupt(): Promise<void> {
    this.activeController?.abort();
  }

  async close(): Promise<void> {
    this.activeController?.abort();
    this.subscribers.clear();
    this.history.length = 0;
    if (this.mcpRuntime) {
      try {
        await this.mcpRuntime.close();
      } catch {
        /* ignore */
      }
    }
  }

  // ── internal ───────────────────────────────────────────────────────────

  /**
   * Walk `this.messages` and, for any assistant `tool_calls` id that lacks a
   * subsequent `role: "tool"` reply, append a synthetic one. Idempotent — if
   * everything is already balanced, no messages are pushed. See call-site in
   * `startTurn` for the why.
   */
  private backfillMissingToolResults(): void {
    const repliedIds = new Set<string>();
    for (const msg of this.messages) {
      if (msg.role === "tool") {
        repliedIds.add(msg.tool_call_id);
      }
    }
    for (const msg of this.messages) {
      if (msg.role !== "assistant" || !("tool_calls" in msg)) continue;
      for (const tc of msg.tool_calls) {
        if (repliedIds.has(tc.id)) continue;
        this.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: "[interrupted by user]",
        });
        repliedIds.add(tc.id);
      }
    }
  }

  private emit(event: AgentStreamEvent): void {
    this.history.push(event);
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch (err) {
        this.logger.warn?.("[hubcode] subscriber threw:", err);
      }
    }
    // Persist on every settled turn so a daemon crash mid-conversation only
    // loses the in-progress turn, not anything already completed. Saving on
    // every message-push would be wasteful and racy with the streaming loop;
    // turn boundaries are the natural commit points.
    if (
      event.type === "turn_completed" ||
      event.type === "turn_canceled" ||
      event.type === "turn_failed"
    ) {
      this.persist();
    }
  }

  private async runTurn(controller: AbortController, turnId: string): Promise<void> {
    const tools = await this.resolveTools();

    for (let iteration = 0; iteration < MAX_TOOL_LOOP_ITERATIONS; iteration++) {
      const body: Record<string, unknown> = {
        model: this.model,
        stream: true,
        messages: buildOpenAiMessages(this.config, this.messages, {
          // In plan mode, prepend a hard preamble so the model knows it's
          // not allowed to call write/exec tools. Without a tool taxonomy
          // on MCP we can't filter the tools list itself, so the prompt
          // is the contract.
          extraSystem: this.currentMode === "plan" ? PLAN_MODE_PREAMBLE : null,
        }),
      };
      if (tools && tools.length > 0) body.tools = tools;
      applyOptionalRequestExtras(body, this.config);

      let stepResult: StepResult;
      try {
        stepResult = await this.streamOneStep(controller, turnId, body);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") {
          this.emit({
            type: "turn_canceled",
            provider: this.provider,
            turnId,
            reason: "user_cancel",
          });
          return;
        }
        throw err;
      }

      if (stepResult.toolCalls.length === 0) {
        // No tool calls — the assistant produced its final text.
        if (stepResult.text.length > 0) {
          this.messages.push({ role: "assistant", content: stepResult.text });
          this.emit({
            type: "timeline",
            provider: this.provider,
            turnId,
            item: { type: "assistant_message", text: stepResult.text },
          });
        }
        this.emit({ type: "turn_completed", provider: this.provider, turnId });
        return;
      }

      // Persist the assistant turn that requested the tools.
      this.messages.push({
        role: "assistant",
        content: stepResult.text || null,
        tool_calls: stepResult.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.argumentsBuffer || "{}" },
        })),
      });
      // If the assistant produced any narrative text alongside the tool
      // call, surface it to the timeline so the user sees the explanation
      // before the tool invocations render.
      if (stepResult.text.length > 0) {
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "assistant_message", text: stepResult.text },
        });
      }

      // Execute every tool serially (parallelism is a follow-up).
      // Mode wins over the legacy `approvalPolicy` flag — the dropdown the
      // user sees in the chat input drives behavior. Only "default" prompts;
      // every other mode auto-approves at this layer (plan mode is enforced
      // separately via the system-prompt preamble below).
      const askApproval = this.currentMode === "default" || this.config.approvalPolicy === "ask";
      let interrupted = false;
      for (const call of stepResult.toolCalls) {
        const callId = call.id || `tc-${turnId}-${iteration}-${call.name}`;
        const args = safeJsonParse(call.argumentsBuffer);

        if (askApproval) {
          const decision = await this.requestToolApproval(callId, call.name, args, turnId);
          if (decision.behavior === "deny") {
            // Surface the denial to the model so it can react accordingly.
            this.emit({
              type: "timeline",
              provider: this.provider,
              turnId,
              item: {
                type: "tool_call",
                callId,
                name: call.name,
                status: "canceled",
                error: null,
                detail: { type: "unknown", input: args, output: null },
              },
            });
            const denyMsg =
              decision.message ??
              "Tool call denied by user; do not retry without explicit consent.";
            this.messages.push({ role: "tool", tool_call_id: callId, content: denyMsg });
            if (decision.interrupt) {
              interrupted = true;
              break;
            }
            continue;
          }
        }

        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "tool_call",
            callId,
            name: call.name,
            status: "running",
            error: null,
            detail: { type: "unknown", input: args, output: null },
          },
        });
        // For voice-mode `speak` calls, surface the spoken text into the chat
        // timeline so the user *sees* what's being read aloud. Without this
        // the chat shows only the collapsed tool call card while audio plays,
        // which makes voice replies feel invisible (and breaks accessibility
        // for anyone who can't hear the audio at that moment).
        if (call.name === "hubcode__speak" && typeof args?.text === "string" && args.text.trim()) {
          this.emit({
            type: "timeline",
            provider: this.provider,
            turnId,
            item: { type: "assistant_message", text: args.text },
          });
        }
        const output = this.mcpRuntime
          ? await this.mcpRuntime.invoke(call.name, args ?? {})
          : JSON.stringify({ error: "MCP runtime not configured" });
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "tool_call",
            callId,
            name: call.name,
            status: "completed",
            error: null,
            detail: { type: "unknown", input: args, output },
          },
        });
        this.messages.push({ role: "tool", tool_call_id: callId, content: output });
      }
      if (interrupted) {
        this.emit({
          type: "turn_canceled",
          provider: this.provider,
          turnId,
          reason: "permission_denied",
        });
        return;
      }
      // Loop: re-call chat/completions with the new tool results.
    }

    this.emit({
      type: "turn_failed",
      provider: this.provider,
      turnId,
      error: `Tool loop exceeded ${MAX_TOOL_LOOP_ITERATIONS} iterations`,
    });
  }

  /**
   * Block until the host responds via `respondToPermission`. Emits a
   * `permission_requested` stream event so the desktop/web/mobile UI can
   * surface the prompt; the corresponding `permission_resolved` event is
   * emitted from `respondToPermission` itself.
   */
  private requestToolApproval(
    callId: string,
    toolName: string,
    input: Record<string, unknown> | null,
    turnId: string,
  ): Promise<AgentPermissionResponse> {
    return new Promise((resolve) => {
      const request: AgentPermissionRequest = {
        id: callId,
        provider: this.provider,
        name: toolName,
        kind: "tool",
        title: `Allow tool: ${toolName}`,
        input: (input ?? undefined) as AgentPermissionRequest["input"],
      };
      this.pendingPermissions.set(callId, { request, resolve });
      this.emit({
        type: "permission_requested",
        provider: this.provider,
        turnId,
        request,
      });
    });
  }

  private async resolveTools(): Promise<OpenAiTool[] | null> {
    if (!this.mcpRuntime) return null;
    if (this.cachedTools === null) {
      try {
        this.cachedTools = await this.mcpRuntime.listOpenAiTools();
      } catch (err) {
        this.logger.warn?.("[hubcode] tool discovery failed:", err);
        this.cachedTools = [];
      }
    }
    // Plan mode: hide every tool that isn't classifiable as read-only so the
    // model can't even *see* a write/exec tool to call. Belt-and-suspenders
    // alongside the PLAN_MODE_PREAMBLE system prompt — prompt is the polite
    // version, this is the enforcement. Recomputed each turn (not cached)
    // since the user can flip modes mid-session.
    if (this.currentMode === "plan") {
      const filtered = this.cachedTools.filter((t) => isReadOnlyTool(t.function.name));
      const dropped = this.cachedTools.length - filtered.length;
      if (dropped > 0) {
        this.logger.debug?.(
          `[hubcode] plan mode hid ${dropped}/${this.cachedTools.length} non-read tools`,
        );
      }
      return filtered;
    }
    return this.cachedTools;
  }

  /**
   * Runs one round-trip to the backend and returns the assistant text +
   * any tool_calls it requested. Streams text deltas to the timeline as
   * `assistant_message` events.
   */
  private async streamOneStep(
    controller: AbortController,
    _turnId: string,
    body: Record<string, unknown>,
  ): Promise<StepResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`hubcode chat ${res.status}: ${detail.slice(0, 200)}`);
    }
    if (!res.body) {
      throw new Error("hubcode chat: empty response body");
    }

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = "";
    let assembled = "";
    const toolCallsByIndex = new Map<number, PendingToolCall>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const parsed = parseSseFrame(frame);
        if (!parsed) continue;
        if (parsed.done) {
          return { text: assembled, toolCalls: orderedToolCalls(toolCallsByIndex) };
        }
        if (parsed.delta) {
          assembled += parsed.delta;
          // Streaming text is accumulated locally and emitted ONCE when the
          // step ends (see callers). Emitting per-delta caused duplicates on
          // some renderers that append rather than replace by message id.
        }
        if (parsed.toolCallDeltas) {
          for (const tcd of parsed.toolCallDeltas) {
            const existing = toolCallsByIndex.get(tcd.index);
            if (existing) {
              if (tcd.id) existing.id = tcd.id;
              if (tcd.name) existing.name = tcd.name;
              if (tcd.arguments) existing.argumentsBuffer += tcd.arguments;
            } else {
              toolCallsByIndex.set(tcd.index, {
                id: tcd.id ?? "",
                name: tcd.name ?? "",
                argumentsBuffer: tcd.arguments ?? "",
              });
            }
          }
        }
      }
    }
    return { text: assembled, toolCalls: orderedToolCalls(toolCallsByIndex) };
  }
}

interface StepResult {
  text: string;
  toolCalls: PendingToolCall[];
}

function orderedToolCalls(map: Map<number, PendingToolCall>): PendingToolCall[] {
  return [...map.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
}

/**
 * Pass-through for backend-side optional features:
 *   - skills: opt-in skill IDs to inject (auto-selection happens server-side).
 *   - sessionId for persistent memory retrieval across turns.
 *   - reasoning_effort derived from `thinkingOptionId`.
 *   - additional knobs from `featureValues` (temperature, top_p, etc) when
 *     the keys match OpenAI chat/completions parameters.
 */
function applyOptionalRequestExtras(
  body: Record<string, unknown>,
  config: AgentSessionConfig,
): void {
  // Reasoning effort — map common thinkingOptionId values onto the OpenAI
  // `reasoning_effort` field. Backend forwards it to providers that grok it.
  const effort = mapReasoningEffort(config.thinkingOptionId ?? null);
  if (effort) body.reasoning_effort = effort;

  const fv = (config.featureValues ?? {}) as Record<string, unknown>;

  // Skills: opt-in array of skill IDs (or `true` for auto-selection).
  if (Array.isArray(fv.skills) && fv.skills.length > 0) {
    body.skills = fv.skills;
  } else if (fv.skills === true) {
    body.skills = "auto";
  }

  // Memory: backend keys retrieval by sessionId (passed in body).
  if (typeof fv.sessionId === "string" && fv.sessionId.length > 0) {
    body.sessionId = fv.sessionId;
  }

  // Pass-through OpenAI knobs.
  for (const key of [
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "max_tokens",
    "tool_choice",
  ]) {
    if (fv[key] !== undefined) body[key] = fv[key];
  }
}

function mapReasoningEffort(id: string | null): "low" | "medium" | "high" | null {
  if (!id) return null;
  const lower = id.toLowerCase();
  if (lower.includes("low") || lower === "minimal") return "low";
  if (lower.includes("high") || lower === "max" || lower === "deep") return "high";
  if (lower.includes("medium") || lower === "default" || lower === "balanced") return "medium";
  return null;
}

function safeJsonParse(input: string): Record<string, unknown> | null {
  if (!input || !input.trim()) return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function promptToText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function buildOpenAiMessages(
  config: AgentSessionConfig,
  turns: ChatMessage[],
  options?: { extraSystem?: string | null },
): unknown[] {
  const out: unknown[] = [];
  if (config.systemPrompt && config.systemPrompt.trim().length > 0) {
    out.push({ role: "system", content: config.systemPrompt });
  }
  if (options?.extraSystem) {
    out.push({ role: "system", content: options.extraSystem });
  }
  for (const m of turns) out.push(m);
  return out;
}

interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

interface SseFrame {
  delta?: string;
  toolCallDeltas?: ToolCallDelta[];
  done?: boolean;
}

export function parseSseFrame(frame: string): SseFrame | null {
  // Each frame is one or more `field: value` lines separated by \n. We only
  // care about `data:` lines; everything else is ignored.
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.startsWith(":") ? "" : rawLine.trim();
    if (!line) continue;
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return { done: true };
  try {
    const json = JSON.parse(payload) as {
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
    };
    const choice = json.choices?.[0];
    const content = choice?.delta?.content;
    const result: SseFrame = {};
    if (typeof content === "string" && content.length > 0) {
      result.delta = content;
    }
    const rawToolCalls = choice?.delta?.tool_calls;
    if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
      result.toolCallDeltas = rawToolCalls.map((tc, i) => ({
        index: typeof tc.index === "number" ? tc.index : i,
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments,
      }));
    }
    if (Object.keys(result).length === 0) return null;
    return result;
  } catch {
    return null;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export { HubcodeAgentClient, HubcodeAgentSession, HubcodeUpgradeRequiredError };
export type { AgentTimelineItem };
