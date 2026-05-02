import { describe, expect, test } from "vitest";
import type { AgentPromptInput, AgentRunOptions, AgentStreamEvent } from "../agent-sdk-types.js";
import { appendOrReplaceGrowingAssistantMessage, runProviderTurn } from "./provider-runner.js";

class FakeTurnRunner {
  readonly events: AgentStreamEvent[] = [];
  private subscriber: ((event: AgentStreamEvent) => void) | null = null;

  constructor(
    private readonly turnId: string,
    private readonly sessionId: string,
    private readonly onStart?: () => void,
  ) {}

  async startTurn(
    _prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    this.onStart?.();
    return { turnId: this.turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscriber = callback;
    return () => {
      this.subscriber = null;
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  emit(event: AgentStreamEvent): void {
    this.events.push(event);
    this.subscriber?.(event);
  }
}

describe("runProviderTurn", () => {
  test("buffers events emitted before startTurn returns", async () => {
    const runner = new FakeTurnRunner("turn-1", "session-1", () => {
      runner.emit({
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: { type: "assistant_message", text: "hello" },
      });
      runner.emit({
        type: "turn_completed",
        provider: "codex",
        turnId: "turn-1",
        usage: { inputTokens: 1 },
      });
    });

    const result = await runProviderTurn({
      prompt: "hi",
      startTurn: (prompt, options) => runner.startTurn(prompt, options),
      subscribe: (callback) => runner.subscribe(callback),
      getSessionId: () => runner.getSessionId(),
    });

    expect(result).toEqual({
      sessionId: "session-1",
      finalText: "hello",
      usage: { inputTokens: 1 },
      timeline: [{ type: "assistant_message", text: "hello" }],
    });
  });

  test("ignores events from other turns after the turn id is known", async () => {
    const runner = new FakeTurnRunner("turn-1", "session-1");
    const resultPromise = runProviderTurn({
      prompt: "hi",
      startTurn: (prompt, options) => runner.startTurn(prompt, options),
      subscribe: (callback) => runner.subscribe(callback),
      getSessionId: () => runner.getSessionId(),
    });

    runner.emit({
      type: "timeline",
      provider: "opencode",
      turnId: "other-turn",
      item: { type: "assistant_message", text: "wrong" },
    });
    runner.emit({
      type: "timeline",
      provider: "opencode",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "right" },
    });
    runner.emit({ type: "turn_completed", provider: "opencode", turnId: "turn-1" });

    await expect(resultPromise).resolves.toMatchObject({
      finalText: "right",
      timeline: [{ type: "assistant_message", text: "right" }],
    });
  });

  test("rejects when the turn fails", async () => {
    const runner = new FakeTurnRunner("turn-1", "session-1");
    const resultPromise = runProviderTurn({
      prompt: "hi",
      startTurn: (prompt, options) => runner.startTurn(prompt, options),
      subscribe: (callback) => runner.subscribe(callback),
      getSessionId: () => runner.getSessionId(),
    });

    runner.emit({
      type: "turn_failed",
      provider: "claude",
      turnId: "turn-1",
      error: "provider failed",
    });

    await expect(resultPromise).rejects.toThrow("provider failed");
  });

  test("supports growing assistant message reducers", async () => {
    const runner = new FakeTurnRunner("turn-1", "session-1");
    const resultPromise = runProviderTurn({
      prompt: "hi",
      startTurn: (prompt, options) => runner.startTurn(prompt, options),
      subscribe: (callback) => runner.subscribe(callback),
      getSessionId: () => runner.getSessionId(),
      reduceFinalText: appendOrReplaceGrowingAssistantMessage,
    });

    runner.emit({
      type: "timeline",
      provider: "acp",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "hello" },
    });
    runner.emit({
      type: "timeline",
      provider: "acp",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "hello world" },
    });
    runner.emit({
      type: "timeline",
      provider: "acp",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "!" },
    });
    runner.emit({ type: "turn_completed", provider: "acp", turnId: "turn-1" });

    await expect(resultPromise).resolves.toMatchObject({
      finalText: "hello world!",
    });
  });
});
