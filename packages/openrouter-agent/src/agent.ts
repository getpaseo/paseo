import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type CancelNotification,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
} from "@agentclientprotocol/sdk";

import { execFileSync } from "node:child_process";

import { streamCompletion, type Message, type ToolCall } from "./openrouter.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import { SkillManager, loadProjectContext, resolveSkillDirs } from "./skills.js";

// Permission modes matching Claude Code's approach
type PermissionMode = "always_ask" | "auto_read" | "auto_edit" | "auto_all";

const PERMISSION_MODES = [
  { value: "always_ask", name: "Always Ask" },
  { value: "auto_read", name: "Auto-approve Reads" },
  { value: "auto_edit", name: "Auto-approve Edits" },
  { value: "auto_all", name: "Auto-approve All" },
];

type Session = {
  id: string;
  messages: Message[];
  model: string;
  cwd: string;
  pendingAbort: AbortController | null;
  permissionMode: PermissionMode;
  // Tools the user has permanently allowed/denied via allow_always/reject_always
  alwaysAllowed: Set<string>;
  alwaysDenied: Set<string>;
  commandsAdvertised: boolean;
};

// Models available through this agent
const AVAILABLE_MODELS = [
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "openai/gpt-4o", label: "GPT-4o" },
  { id: "google/gemini-2.5-pro-preview", label: "Gemini 2.5 Pro" },
  { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick" },
  { id: "deepseek/deepseek-r1", label: "DeepSeek R1" },
];

function isPermissionMode(value: string): value is PermissionMode {
  return ["always_ask", "auto_read", "auto_edit", "auto_all"].includes(value);
}

// macOS Keychain item identifiers. Reverse-DNS form to avoid collisions with
// other tools that might also store an OpenRouter key.
const KEYCHAIN_SERVICE = "com.paseo.openrouter-agent";
const KEYCHAIN_ACCOUNT = "default";

function resolveApiKey(): string | null {
  // 1. Environment variable (explicit, highest priority).
  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  if (envKey && envKey !== "YOUR_KEY_HERE") {
    return envKey;
  }

  // 2. macOS Keychain fallback — no plain-text key on disk.
  if (process.platform === "darwin") {
    const keychainKey = readMacOSKeychain();
    if (keychainKey) {
      process.stderr.write(
        `[openrouter-agent] using API key from macOS Keychain (service=${KEYCHAIN_SERVICE}, account=${KEYCHAIN_ACCOUNT})\n`,
      );
      return keychainKey;
    }
  }

  return null;
}

function readMacOSKeychain(): string | null {
  try {
    // execFileSync — no shell, no injection risk even if constants become
    // configurable later. -w prints only the secret to stdout. No -g flag:
    // we never want an interactive GUI prompt from a daemon subprocess.
    const result = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      {
        encoding: "utf8",
        timeout: 2000,
        // Silence "not found" stderr noise when the item doesn't exist.
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return result || null;
  } catch {
    // Non-zero exit: item not found, keychain locked, or timeout. Fail quiet.
    return null;
  }
}

export class OpenRouterAgent {
  private connection: AgentSideConnection;
  private sessions = new Map<string, Session>();
  private apiKey: string | null;
  private defaultModel: string;
  private skillManager: SkillManager;

  constructor(connection: AgentSideConnection) {
    this.connection = connection;
    this.apiKey = resolveApiKey();
    this.defaultModel = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4";
    this.skillManager = new SkillManager(resolveSkillDirs());
    this.skillManager.scan();

    process.stderr.write(`[openrouter-agent] loaded ${this.skillManager.list().length} skills\n`);

    if (!this.apiKey) {
      process.stderr.write(
        "[openrouter-agent] OPENROUTER_API_KEY not configured. Set it via one of:\n" +
          "  1. ~/.paseo/config.json → agents.providers.openrouter.env.OPENROUTER_API_KEY\n" +
          "  2. macOS Keychain (recommended, no plain-text on disk):\n" +
          `       security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w "sk-or-v1-..."\n`,
      );
    }
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    const cwd = params.cwd ?? process.cwd();
    const projectContext = loadProjectContext(cwd);
    logProjectContextSize(projectContext, cwd);
    const systemPrompt = buildSystemPrompt(cwd, projectContext);

    this.sessions.set(sessionId, {
      id: sessionId,
      messages: [{ role: "system", content: systemPrompt }],
      model: this.defaultModel,
      cwd,
      pendingAbort: null,
      permissionMode: "always_ask",
      alwaysAllowed: new Set(),
      alwaysDenied: new Set(),
      commandsAdvertised: false,
    });

    // Fire-and-forget: advertise commands early so / menu works before first prompt
    this.advertiseCommands(sessionId).catch(() => {});

    return {
      sessionId,
      configOptions: buildConfigOptions(this.defaultModel, "always_ask"),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    // Resume by creating a fresh session with the requested ID.
    // We lose conversation history, but the UI doesn't hang.
    const sessionId = params.sessionId;
    const cwd = params.cwd ?? process.cwd();
    const projectContext = loadProjectContext(cwd);
    logProjectContextSize(projectContext, cwd);
    const systemPrompt = buildSystemPrompt(cwd, projectContext);

    this.sessions.set(sessionId, {
      id: sessionId,
      messages: [{ role: "system", content: systemPrompt }],
      model: this.defaultModel,
      cwd,
      pendingAbort: null,
      permissionMode: "always_ask",
      alwaysAllowed: new Set(),
      alwaysDenied: new Set(),
      commandsAdvertised: false,
    });

    // Fire-and-forget: advertise commands early so / menu works before first prompt
    this.advertiseCommands(sessionId).catch(() => {});

    return {
      configOptions: buildConfigOptions(this.defaultModel, "always_ask"),
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions.get(params.sessionId);
    if (session && isPermissionMode(params.modeId)) {
      session.permissionMode = params.modeId;
      session.alwaysAllowed.clear();
      session.alwaysDenied.clear();
    }
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    if (params.configId === "model" && typeof params.value === "string") {
      session.model = params.value;
    }

    if (params.configId === "permissions" && typeof params.value === "string") {
      session.permissionMode = params.value as PermissionMode;
      // Reset persistent approvals when mode changes
      session.alwaysAllowed.clear();
      session.alwaysDenied.clear();
    }

    return {
      configOptions: buildConfigOptions(session.model, session.permissionMode),
    };
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);
    session.model = params.modelId;
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingAbort?.abort();
  }

  /** Send available_commands_update and mark as advertised. Safe to call multiple times. */
  private async advertiseCommands(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.commandsAdvertised) return;

    const commands = this.skillManager.toAvailableCommands();
    if (commands.length === 0) return;

    session.commandsAdvertised = true;
    await this.connection.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: commands,
      },
    });
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    // Gate on API key before doing any work
    if (!this.apiKey) {
      await this.connection.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text:
              "**OpenRouter API key not configured.**\n\n" +
              "Set your key in `~/.paseo/config.json`:\n\n" +
              "```json\n" +
              '"agents": {\n' +
              '  "providers": {\n' +
              '    "openrouter": {\n' +
              '      "env": {\n' +
              '        "OPENROUTER_API_KEY": "sk-or-v1-..."\n' +
              "      }\n" +
              "    }\n" +
              "  }\n" +
              "}\n" +
              "```\n\n" +
              "Then restart the Paseo daemon to pick up the change.",
          },
        },
      });
      return { stopReason: "end_turn" };
    }

    // Re-advertise commands if the early fire-and-forget in newSession/loadSession missed
    await this.advertiseCommands(session.id);

    // Cancel any pending turn
    session.pendingAbort?.abort();
    session.pendingAbort = new AbortController();
    const signal = session.pendingAbort.signal;

    // Extract text from ACP content blocks
    let userText = params.prompt
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    // Detect slash command prefix and inject skill content
    const skillMatch = userText.match(/^\/([\w-]+)\s*([\s\S]*)?$/);
    if (skillMatch) {
      const skillContent = this.skillManager.getContent(skillMatch[1]);
      if (skillContent) {
        session.messages.push({
          role: "system",
          content: `The user invoked the /${skillMatch[1]} skill. Follow these instructions:\n\n${skillContent}`,
        });
        // Use remaining text as the actual user message, or a generic activation
        userText = skillMatch[2]?.trim() || `Execute the /${skillMatch[1]} skill.`;
      }
    }

    session.messages.push({ role: "user", content: userText });

    try {
      await this.runAgentLoop(session, signal);
    } catch (err) {
      if (signal.aborted) {
        return { stopReason: "cancelled" };
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[openrouter-agent] turn error: ${rawMessage}\n`);
      const formatted = formatApiError(rawMessage);
      await this.connection.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: formatted },
        },
      });
      return { stopReason: "end_turn" };
    } finally {
      session.pendingAbort = null;
    }

    return { stopReason: "end_turn" };
  }

  private async runAgentLoop(session: Session, signal: AbortSignal): Promise<void> {
    const MAX_TOOL_ROUNDS = 25;
    // D.7: After this many consecutive rounds of tools-but-no-text, assume the
    // model is stuck in a reasoning/tool-calling loop and bail out early. 5 is
    // a sensible cap — legitimate agents almost always produce *some* user-
    // visible text within the first few rounds of a turn.
    const MAX_CONSECUTIVE_EMPTY_ROUNDS = 5;

    let receivedAnyContent = false;
    let firstReasoning = "";
    let lastReasoning = "";
    let consecutiveEmptyRounds = 0;
    let stuckInToolLoop = false;
    const toolCounts = new Map<string, number>();
    let lastRound = -1;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      lastRound = round;
      const { text, reasoning, toolCalls, usage } = await this.streamResponse(session, signal);

      // D.3: per-round diagnostics
      const toolNames = toolCalls.map((tc) => tc.function.name).join(",");
      process.stderr.write(
        `[openrouter-agent] round=${round} text=${text.length}ch ` +
          `reasoning=${reasoning.length}ch tools=${toolCalls.length}` +
          (toolNames ? ` [${toolNames}]` : "") +
          (usage ? ` usage=${usage.prompt_tokens}/${usage.completion_tokens}` : "") +
          "\n",
      );

      if (text.length > 0) receivedAnyContent = true;
      if (reasoning.length > 0) {
        lastReasoning = reasoning;
        if (!firstReasoning) firstReasoning = reasoning;
      }
      for (const tc of toolCalls) {
        toolCounts.set(tc.function.name, (toolCounts.get(tc.function.name) ?? 0) + 1);
      }

      // Append assistant message to history
      const assistantMsg: Message = { role: "assistant", content: text };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      session.messages.push(assistantMsg);

      // Report usage
      if (usage) {
        await this.connection.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "usage_update",
            usage: {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
            },
          },
        });
      }

      // If no tool calls, the turn is done
      if (toolCalls.length === 0) break;

      // D.7: Track consecutive content-less rounds. If the model keeps calling
      // tools without ever committing to a visible answer, bail out early.
      if (text.length === 0) {
        consecutiveEmptyRounds++;
      } else {
        consecutiveEmptyRounds = 0;
      }

      if (consecutiveEmptyRounds >= MAX_CONSECUTIVE_EMPTY_ROUNDS) {
        stuckInToolLoop = true;
        process.stderr.write(
          `[openrouter-agent] stuck-in-tool-loop detected: ` +
            `${consecutiveEmptyRounds} consecutive content-less rounds, bailing out ` +
            `(model=${session.model}, total tool calls=${sumCounts(toolCounts)})\n`,
        );
        break;
      }

      // Execute each tool call
      for (const tc of toolCalls) {
        if (signal.aborted) return;
        await this.executeTool(session, tc, signal);
      }
    }

    if (signal.aborted) return;

    // D.1 + D.2: never silent-exit. If the model ended its turn with no visible
    // content, surface something to the user — the reasoning trace if we have
    // one, otherwise an explanatory diagnostic.
    if (!receivedAnyContent) {
      const fallbackText = buildSilentCompletionMessage({
        model: session.model,
        rounds: lastRound + 1,
        firstReasoning,
        lastReasoning,
        toolCounts,
        stuckInToolLoop,
      });
      process.stderr.write(
        `[openrouter-agent] silent-completion fallback emitted ` +
          `(model=${session.model}, rounds=${lastRound + 1}, ` +
          `tools=${sumCounts(toolCounts)}, stuck=${stuckInToolLoop})\n`,
      );
      await this.connection.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: fallbackText },
        },
      });
    }
  }

  private async streamResponse(
    session: Session,
    signal: AbortSignal,
  ): Promise<{
    text: string;
    reasoning: string;
    toolCalls: ToolCall[];
    usage?: { prompt_tokens: number; completion_tokens: number };
  }> {
    let fullText = "";
    let fullReasoning = "";
    const toolCallAccumulators = new Map<number, { id: string; name: string; args: string }>();
    let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

    const stream = streamCompletion(
      this.apiKey!,
      {
        model: session.model,
        messages: session.messages,
        tools: TOOL_DEFINITIONS.length > 0 ? TOOL_DEFINITIONS : undefined,
        stream: true,
      },
      signal,
    );

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;

      // Stream reasoning/thinking content (DeepSeek R1, etc.)
      if (delta.reasoning_content) {
        fullReasoning += delta.reasoning_content;
        await this.connection.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: delta.reasoning_content },
          },
        });
      }

      // Stream text content
      if (delta.content) {
        fullText += delta.content;
        await this.connection.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: delta.content },
          },
        });
      }

      // Accumulate tool calls (they arrive across multiple deltas)
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let acc = toolCallAccumulators.get(tc.index);
          if (!acc) {
            acc = { id: tc.id ?? "", name: "", args: "" };
            toolCallAccumulators.set(tc.index, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }

      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
        };
      }
    }

    const toolCalls: ToolCall[] = [...toolCallAccumulators.values()].map((acc) => ({
      id: acc.id,
      type: "function" as const,
      function: { name: acc.name, arguments: acc.args },
    }));

    return { text: fullText, reasoning: fullReasoning, toolCalls, usage };
  }

  private async executeTool(
    session: Session,
    toolCall: ToolCall,
    signal: AbortSignal,
  ): Promise<void> {
    const { name, arguments: argsJson } = toolCall.function;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson);
    } catch {
      await this.pushToolResult(session, toolCall.id, `Error: invalid JSON arguments`);
      return;
    }

    // Notify Paseo that a tool call is starting
    await this.connection.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: toolCall.id,
        title: formatToolTitle(name, args),
        kind: toolKind(name),
        status: "pending",
        locations: toolLocations(name, args),
        rawInput: args,
      },
    });

    let result: string;
    try {
      result = await this.dispatchTool(session, name, args, toolCall.id, signal);
    } catch (err) {
      result = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Notify Paseo that the tool call completed
    await this.connection.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: toolCall.id,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: result } }],
        rawOutput: { result },
      },
    });

    // Add tool result to message history
    await this.pushToolResult(session, toolCall.id, result);
  }

  /**
   * Check if a tool should be auto-approved based on permission mode and
   * persistent allow/deny decisions.
   * Returns "allow" | "deny" | "ask"
   */
  private checkAutoApproval(session: Session, toolName: string): "allow" | "deny" | "ask" {
    // Check persistent deny first (always takes priority)
    if (session.alwaysDenied.has(toolName)) return "deny";

    // Check persistent allow
    if (session.alwaysAllowed.has(toolName)) return "allow";

    // Check permission mode
    const kind = toolKind(toolName);
    switch (session.permissionMode) {
      case "auto_all":
        return "allow";
      case "auto_edit":
        // Auto-approve reads and edits, ask for commands
        if (kind === "read" || kind === "edit") return "allow";
        break;
      case "auto_read":
        // Auto-approve reads only
        if (kind === "read") return "allow";
        break;
      case "always_ask":
      default:
        break;
    }

    return "ask";
  }

  /**
   * Request permission from the user via ACP, with all 4 option kinds.
   * Returns true if allowed, false if denied.
   */
  private async requestToolPermission(
    session: Session,
    toolName: string,
    toolCallId: string,
    title: string,
    kind: string,
    args: Record<string, unknown>,
    locations?: Array<{ path: string }>,
  ): Promise<boolean> {
    // Check auto-approval first
    const autoResult = this.checkAutoApproval(session, toolName);
    if (autoResult === "allow") return true;
    if (autoResult === "deny") return false;

    // Request permission from user with all 4 option kinds
    const perm = await this.connection.requestPermission({
      sessionId: session.id,
      toolCall: {
        toolCallId,
        title,
        kind,
        status: "pending",
        locations,
        rawInput: args,
      },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow_once" },
        { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
        { kind: "reject_once", name: "Deny", optionId: "reject_once" },
        { kind: "reject_always", name: "Always Deny", optionId: "reject_always" },
      ],
    });

    if (perm.outcome.outcome === "cancelled") return false;

    // Handle persistent decisions
    switch (perm.outcome.optionId) {
      case "allow_always":
        session.alwaysAllowed.add(toolName);
        return true;
      case "allow_once":
        return true;
      case "reject_always":
        session.alwaysDenied.add(toolName);
        return false;
      case "reject_once":
      default:
        return false;
    }
  }

  private async dispatchTool(
    session: Session,
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    _signal: AbortSignal,
  ): Promise<string> {
    switch (name) {
      case "read_file": {
        const path = args.path as string;

        const allowed = await this.requestToolPermission(
          session,
          name,
          toolCallId,
          `Read ${path}`,
          "read",
          args,
          [{ path }],
        );
        if (!allowed) return "Permission denied by user.";

        const res = await this.connection.readTextFile({ path });
        return res.content;
      }

      case "write_file": {
        const path = args.path as string;
        const content = args.content as string;

        const allowed = await this.requestToolPermission(
          session,
          name,
          toolCallId,
          `Write ${path}`,
          "edit",
          args,
          [{ path }],
        );
        if (!allowed) return "Permission denied by user.";

        await this.connection.writeTextFile({ path, content });
        return `Successfully wrote ${content.length} bytes to ${path}`;
      }

      case "run_command": {
        const command = args.command as string;

        const allowed = await this.requestToolPermission(
          session,
          name,
          toolCallId,
          `Run: ${command}`,
          "execute",
          args,
        );
        if (!allowed) return "Permission denied by user.";

        // Wrap in shell so pipes, redirects, and globs work
        await using terminal = await this.connection.createTerminal({
          sessionId: session.id,
          command: "/bin/sh",
          args: ["-c", command],
          cwd: session.cwd,
        });

        const exit = await terminal.waitForExit();
        const output = await terminal.currentOutput();

        return [`Exit code: ${exit.exitCode ?? "unknown"}`, output.output ?? "(no output)"].join(
          "\n",
        );
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  private async pushToolResult(
    session: Session,
    toolCallId: string,
    content: string,
  ): Promise<void> {
    const trimmed = truncateToolResult(content, toolCallId);
    session.messages.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: trimmed,
    });
  }
}

/**
 * D.4: Cap tool result size fed back into the model. Large file reads can burn
 * all the model's output tokens on re-reasoning, leaving nothing for the final
 * answer. 50KB per result is plenty for most prompts.
 */
const MAX_TOOL_RESULT_BYTES = 50_000;

function truncateToolResult(content: string, toolCallId: string): string {
  if (Buffer.byteLength(content, "utf-8") <= MAX_TOOL_RESULT_BYTES) {
    return content;
  }
  const head = content.slice(0, MAX_TOOL_RESULT_BYTES - 200);
  const note =
    `\n\n[openrouter-agent: result truncated — original was ` +
    `${content.length.toLocaleString()} chars / ` +
    `${Buffer.byteLength(content, "utf-8").toLocaleString()} bytes]`;
  process.stderr.write(
    `[openrouter-agent] truncated tool result for ${toolCallId}: ` +
      `${content.length} → ${head.length} chars\n`,
  );
  return head + note;
}

/** D.5: Log when a large CLAUDE.md gets injected into the system prompt. */
function logProjectContextSize(projectContext: string | null, cwd: string): void {
  if (!projectContext) return;
  const bytes = Buffer.byteLength(projectContext, "utf-8");
  if (bytes > 4096) {
    process.stderr.write(
      `[openrouter-agent] CLAUDE.md injected: ${bytes.toLocaleString()} bytes ` +
        `(${Math.round(bytes / 1024)}KB) from ${cwd}\n`,
    );
  }
}

/** Sum the values of a Map<string, number>. */
function sumCounts(counts: Map<string, number>): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

/** Format a tool-count map as "read_file ×15, write_file ×3". */
function formatToolCounts(counts: Map<string, number>): string {
  if (counts.size === 0) return "none";
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `\`${name}\` ×${n}`)
    .join(", ");
}

/**
 * D.1 + D.2 + D.7: Build a user-visible fallback message when the model ends
 * its turn without producing any assistant content. The message explains what
 * happened — either the model stopped quietly, or got stuck in a tool-calling
 * loop — and surfaces its reasoning when available so the user has signal to
 * act on.
 */
function buildSilentCompletionMessage(opts: {
  model: string;
  rounds: number;
  firstReasoning: string;
  lastReasoning: string;
  toolCounts: Map<string, number>;
  stuckInToolLoop: boolean;
}): string {
  const { model, rounds, firstReasoning, lastReasoning, toolCounts, stuckInToolLoop } = opts;
  const totalTools = sumCounts(toolCounts);

  const header = stuckInToolLoop
    ? `**The model got stuck in a tool-calling loop** — it kept calling tools ` +
      `without ever producing a final answer.`
    : `**The model ended its turn without a final answer.**`;

  const stats =
    `- Model: \`${model}\`\n` +
    `- Rounds: ${rounds}\n` +
    `- Tool calls: ${totalTools > 0 ? `${totalTools} (${formatToolCounts(toolCounts)})` : "none"}`;

  // Prefer the first reasoning trace — that's where the model laid out its plan.
  const reasoning = firstReasoning.trim() || lastReasoning.trim();
  const reasoningBlock = reasoning.length > 0 ? buildReasoningBlock(reasoning) : "";

  const tip = isKnownReasoningModel(model)
    ? `*Tip: \`${model}\` is a reasoning model with limited tool-calling support. ` +
      `For tool-heavy work, switch to Claude Sonnet 4, GPT-4o, or Llama 4 Maverick.*`
    : `*Tip: try rephrasing your request, clearing conversation history, or ` +
      `switching to a different model.*`;

  return [header, "", stats, reasoningBlock, tip].filter(Boolean).join("\n\n");
}

function buildReasoningBlock(reasoning: string): string {
  const MAX_LEN = 1500;
  const preview = reasoning.length > MAX_LEN ? reasoning.slice(0, MAX_LEN) + "…" : reasoning;
  const quoted = preview.replace(/\n/g, "\n> ");
  return `**Model's reasoning:**\n\n> ${quoted}`;
}

/** Models that are known to emit `reasoning_content` and struggle with tools. */
function isKnownReasoningModel(model: string): boolean {
  const id = model.toLowerCase();
  return id.includes("r1") || id.includes("deepseek-reasoner") || id.includes("o1");
}

/**
 * D.8: Format OpenRouter/provider API errors into concise, readable messages.
 * The raw form from streamCompletion is `OpenRouter API error <status>: <body>`
 * where body is OpenRouter's nested JSON. We pull out the human-readable bits
 * (status code, upstream provider, message) and suggest appropriate remedies.
 */
function formatApiError(raw: string): string {
  const match = raw.match(/^OpenRouter API error (\d+): (.+)$/s);
  if (!match) {
    // Non-HTTP error (connect timeout, stream idle, SSE parse, aborted, etc.)
    return `**Error**\n\n${raw}`;
  }

  const [, statusStr, body] = match;
  const status = Number.parseInt(statusStr, 10);

  let message = body;
  let provider: string | undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: string;
        metadata?: { raw?: string; provider_name?: string };
      };
    };
    message = parsed.error?.metadata?.raw ?? parsed.error?.message ?? body;
    provider = parsed.error?.metadata?.provider_name;
  } catch {
    // Body wasn't JSON — fall through with the raw string (truncated below).
  }
  if (message.length > 500) message = message.slice(0, 500) + "…";

  const providerSuffix = provider ? ` (upstream: ${provider})` : "";

  switch (status) {
    case 429:
      return (
        `**Rate limited${providerSuffix}**\n\n` +
        `${message}\n\n` +
        `*Try again in ~30 seconds, switch to a different model, or add your own ` +
        `provider API key at <https://openrouter.ai/settings/integrations>.*`
      );
    case 401:
    case 403:
      return (
        `**Authentication error** (HTTP ${status})${providerSuffix}\n\n` +
        `${message}\n\n` +
        `*Check \`OPENROUTER_API_KEY\` in \`~/.paseo/config.json\` under ` +
        `\`agents.providers.openrouter.env\`.*`
      );
    case 402:
      return (
        `**Insufficient credits**\n\n` +
        `${message}\n\n` +
        `*Add credits at <https://openrouter.ai/credits> or switch to a ` +
        `free model.*`
      );
    case 404:
      return (
        `**Model not found** (HTTP 404)${providerSuffix}\n\n` +
        `${message}\n\n` +
        `*The selected model may have been removed from OpenRouter. Switch ` +
        `to another model.*`
      );
    case 500:
    case 502:
    case 503:
    case 504:
      return (
        `**Upstream error** (HTTP ${status})${providerSuffix}\n\n` +
        `${message}\n\n` +
        `*The provider is having issues. Retry shortly or switch models.*`
      );
    default:
      return `**API error** (HTTP ${status})${providerSuffix}\n\n${message}`;
  }
}

/** Build all config options for a session */
function buildConfigOptions(currentModel: string, currentPermissionMode: PermissionMode) {
  return [
    {
      type: "select" as const,
      id: "model",
      category: "model",
      name: "Model",
      currentValue: currentModel,
      options: AVAILABLE_MODELS.map((m) => ({
        value: m.id,
        name: m.label,
      })),
    },
    {
      type: "select" as const,
      id: "permissions",
      category: "mode",
      name: "Permissions",
      currentValue: currentPermissionMode,
      options: PERMISSION_MODES.map((m) => ({
        value: m.value,
        name: m.name,
      })),
    },
  ];
}

function buildSystemPrompt(cwd: string, projectContext: string | null): string {
  const parts = [
    "You are a coding assistant with access to the user's file system and terminal.",
    `The user's working directory is: ${cwd}`,
    "",
    "You have the following tools available:",
    "- read_file: Read a file's contents",
    "- write_file: Create or overwrite a file",
    "- run_command: Execute a shell command",
    "",
    "Use tools when you need to interact with the codebase. Read files before modifying them.",
    "Be concise and focused. Prefer editing existing files over creating new ones.",
  ];

  if (projectContext) {
    parts.push("", "## Project Context (from CLAUDE.md)", "", projectContext);
  }

  return parts.join("\n");
}

function formatToolTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return `Read ${args.path}`;
    case "write_file":
      return `Write ${args.path}`;
    case "run_command":
      return `Run: ${args.command}`;
    default:
      return name;
  }
}

function toolKind(name: string): string {
  switch (name) {
    case "read_file":
      return "read";
    case "write_file":
      return "edit";
    case "run_command":
      return "execute";
    default:
      return "execute";
  }
}

function toolLocations(
  name: string,
  args: Record<string, unknown>,
): Array<{ path: string }> | undefined {
  if (name === "read_file" || name === "write_file") {
    return [{ path: args.path as string }];
  }
  return undefined;
}
