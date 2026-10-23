import { createSdkMcpServer, tool, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeQuery, type ClaudeQueryFactory } from "../../agent/providers/claude/query.js";
import { allowedToolNames, TOOL_SERVER_NAME, type ToolDef } from "./tools.js";
import type { Brain, BrainEvent, ModelFlag } from "./types.js";

export const VOICE_BRAIN_PROMPT =
  "You are Michael's voice assistant for his Alchemist harness. Your reply is spoken aloud. Answer in one or " +
  "two short spoken sentences, in plain words: no markdown, lists, emoji or code. Be as sharp as the overseer: " +
  "know the state below, say what matters, skip the preamble. You have read-only tools for the harness and for " +
  "running Paseo agents; call one when asked about their state or when the context below is not enough, then " +
  "answer briefly. When asked what an agent is doing, read its timeline and summarize it aloud. You never " +
  "push, merge, delete or spend, and you never launch work yourself. To delegate work, propose it through " +
  "the ledger: it is confirmed and launched only through the ledger confirm and launch path, never by you " +
  "directly.";

export interface SdkBrainOptions {
  model: ModelFlag;
  tools: ToolDef[];
  /** Harness context block from buildContext, appended to the system prompt. */
  context?: string;
  systemPrompt?: string;
  cwd?: string;
  maxTurns?: number;
  /** Test seam: replaces the real SDK query launcher. */
  queryFactory?: ClaudeQueryFactory;
  /** How long an interrupted turn may take to drain before the session is rebuilt. */
  drainTimeoutMs?: number;
}

/** Environment for the Claude subprocess: subscription login only, never a metered API key. */
export function subscriptionEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && key !== "ANTHROPIC_API_KEY" && key !== "ANTHROPIC_AUTH_TOKEN") {
      env[key] = value;
    }
  }
  return env;
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(item: SDKUserMessage): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) this.waiter({ value: undefined, done: true });
    this.waiter = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

type SdkQuery = ReturnType<ClaudeQueryFactory>;

/**
 * One warm Claude session on the subscription login: streaming input, partial messages so text
 * arrives token by token, read-only in-process tools, no built-in tools, no settings files.
 */
export class SdkBrain implements Brain {
  private session: { input: InputQueue; query: SdkQuery; iterator: AsyncIterator<unknown> } | null =
    null;
  private interrupted = false;

  constructor(private readonly options: SdkBrainOptions) {}

  private start() {
    const { model, tools, context, systemPrompt, cwd, maxTurns, queryFactory } = this.options;
    const server = createSdkMcpServer({
      name: TOOL_SERVER_NAME,
      tools: tools.map((t) =>
        tool(t.name, t.description, t.shape, async (args: Record<string, unknown>) => ({
          content: [{ type: "text" as const, text: await t.run(args) }],
        })),
      ),
    });
    const input = new InputQueue();
    const query = claudeQuery(
      {
        prompt: input,
        options: {
          model,
          cwd,
          systemPrompt: `${systemPrompt ?? VOICE_BRAIN_PROMPT}${context ? `\n\n${context}` : ""}`,
          tools: [],
          settingSources: [],
          mcpServers: { [TOOL_SERVER_NAME]: server },
          strictMcpConfig: true,
          allowedTools: allowedToolNames(tools),
          maxTurns: maxTurns ?? 4,
          includePartialMessages: true,
          thinking: { type: "disabled" },
          env: subscriptionEnv(),
        },
      },
      { queryFactory },
    );
    this.session = { input, query, iterator: query[Symbol.asyncIterator]() };
    return this.session;
  }

  async *runTurn(userText: string): AsyncGenerator<BrainEvent> {
    const session = this.session ?? this.start();
    this.interrupted = false;
    session.input.push({
      type: "user",
      message: { role: "user", content: userText },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    for (;;) {
      let next: IteratorResult<unknown>;
      try {
        next = await session.iterator.next();
      } catch (error) {
        // A dead session must not be reused: the next turn starts a fresh one.
        if (this.session === session) void this.reset();
        throw error;
      }
      if (next.done) {
        this.session = null;
        return;
      }
      const message = next.value as { type: string; [key: string]: unknown };
      if (message.type === "result") {
        const wasInterrupted = this.interrupted;
        this.interrupted = false;
        const failure = resultFailure(message);
        // An interrupted turn ends in an error result by design; the agent already moved on.
        if (failure && !wasInterrupted) throw new Error(failure);
        return;
      }
      if (this.interrupted) continue; // drain to the result without emitting
      const event = toBrainEvent(message);
      if (event) yield event;
    }
  }

  async interrupt(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.interrupted = true;
    const drain = this.options.drainTimeoutMs ?? 10_000;
    try {
      await session.query.interrupt();
    } catch {
      // The session may already be finished.
    }
    // runTurn keeps draining to the result. If it does not get there, rebuild next turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    setTimeout(() => {
      if (this.session === session && this.interrupted) void this.reset();
    }, drain).unref();
  }

  private async reset(): Promise<void> {
    const session = this.session;
    this.session = null;
    session?.input.close();
    try {
      await session?.iterator.return?.();
    } catch {
      // ignore
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }
}

/** A message for a failed SDK result (error subtype or is_error), or null for a success. */
export function resultFailure(message: { [key: string]: unknown }): string | null {
  const subtype = typeof message.subtype === "string" ? message.subtype : undefined;
  const errors = Array.isArray(message.errors) ? message.errors.map(String).join("; ") : "";
  if ((subtype && subtype !== "success") || message.is_error === true) {
    return `Claude turn failed (${subtype ?? "error"})${errors ? `: ${errors}` : ""}`;
  }
  return null;
}

/** Maps one SDK message to a brain event, or null when it carries nothing to say or do. */
export function toBrainEvent(message: { type: string; [key: string]: unknown }): BrainEvent | null {
  if (message.type === "stream_event") {
    const event = message.event as
      | { type?: string; delta?: { type?: string; text?: string } }
      | undefined;
    if (
      event?.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      event.delta.text
    ) {
      return { type: "text", text: event.delta.text };
    }
    return null;
  }
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  if (message.type === "assistant") {
    const use = content.find((b) => (b as { type?: string }).type === "tool_use") as
      | { name?: string }
      | undefined;
    if (use) return { type: "tool_use", name: use.name ?? "" };
  }
  if (
    message.type === "user" &&
    content.some((b) => (b as { type?: string }).type === "tool_result")
  ) {
    return { type: "tool_result" };
  }
  return null;
}
