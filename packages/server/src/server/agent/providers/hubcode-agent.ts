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
//   - Persisted sessions (resumeSession) — needs DB integration.
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
import { HubcodeMcpRuntime, type OpenAiTool } from "./hubcode-mcp-runtime.js";

const DEFAULT_AUTH_URL = process.env.HUBCODE_AUTH_SERVER_URL || "http://localhost:3002";
const MAX_TOOL_LOOP_ITERATIONS = 10;

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
    return [];
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
    _handle: AgentPersistenceHandle,
    _overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    throw new Error("Hubcode agent does not support persisted sessions yet.");
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
  readonly id: string | null = null;

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
  private turnCounter = 0;
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
      modeId: null,
    };
  }
  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(_modeId: string): Promise<void> {
    /* no-op */
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
    return null;
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
    this.turnCounter += 1;
    const turnId = `hubcode-${this.turnCounter}`;
    const controller = new AbortController();
    this.activeController = controller;

    const userText = typeof prompt === "string" ? prompt : promptToText(prompt);
    this.messages.push({ role: "user", content: userText });
    this.emit({ type: "turn_started", provider: this.provider, turnId });
    // We intentionally do NOT emit a `user_message` timeline item — the chat
    // UI already renders the user's bubble from the input area as soon as
    // they hit send. Re-emitting here would duplicate the bubble.

    // Run the HTTP + SSE in the background so startTurn can return promptly.
    void this.runTurn(controller, turnId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "turn_failed", provider: this.provider, turnId, error: message });
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

  private emit(event: AgentStreamEvent): void {
    this.history.push(event);
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch (err) {
        this.logger.warn?.("[hubcode] subscriber threw:", err);
      }
    }
  }

  private async runTurn(controller: AbortController, turnId: string): Promise<void> {
    const tools = await this.resolveTools();

    for (let iteration = 0; iteration < MAX_TOOL_LOOP_ITERATIONS; iteration++) {
      const body: Record<string, unknown> = {
        model: this.model,
        stream: true,
        messages: buildOpenAiMessages(this.config, this.messages),
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
      const askApproval = this.config.approvalPolicy === "ask";
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
    if (this.cachedTools !== null) return this.cachedTools;
    try {
      this.cachedTools = await this.mcpRuntime.listOpenAiTools();
    } catch (err) {
      this.logger.warn?.("[hubcode] tool discovery failed:", err);
      this.cachedTools = [];
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
    turnId: string,
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

function buildOpenAiMessages(config: AgentSessionConfig, turns: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  if (config.systemPrompt && config.systemPrompt.trim().length > 0) {
    out.push({ role: "system", content: config.systemPrompt });
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
