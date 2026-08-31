import { describe, expect, test } from "vitest";

import type { CodexThreadRevertParams, CodexThreadRevertResponse } from "./app-server-transport.js";
import { CodexAppServerRpcError } from "./app-server-transport.js";
import {
  type CodexRewindClient,
  type CodexUserMessageTurnIndex,
  revertCodexConversation,
} from "./rewind.js";

class FakeCodex implements CodexRewindClient {
  readonly recordedReverts: CodexThreadRevertParams[] = [];

  constructor(
    private readonly result: (
      params: CodexThreadRevertParams,
    ) => Promise<CodexThreadRevertResponse> | CodexThreadRevertResponse = (params) => ({
      thread: { id: params.threadId, sessionId: "source-session", turns: [] },
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    }),
  ) {}

  async revertThread(params: CodexThreadRevertParams): Promise<CodexThreadRevertResponse> {
    this.recordedReverts.push(params);
    return this.result(params);
  }

  request(): Promise<unknown> {
    throw new Error("FakeCodex uses typed thread methods");
  }
}

class CodexMessageTurns implements CodexUserMessageTurnIndex {
  constructor(private readonly turnIdsByMessageId: Map<string, string | null>) {}

  resolve(messageId: string): { turnId: string | null } | null {
    if (!this.turnIdsByMessageId.has(messageId)) return null;
    return { turnId: this.turnIdsByMessageId.get(messageId) ?? null };
  }
}

describe("Codex Rewind", () => {
  test("rewinds to the first user message by reverting before its turn", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", "turn-first"],
        ["codex-second", "turn-second"],
      ]),
    );
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-first",
      userMessageTurns,
      setThreadId: (threadId) => {
        reboundThreadId = threadId;
      },
    });

    expect(codex.recordedReverts).toEqual([
      { threadId: "source-thread", beforeTurnId: "turn-first" },
    ]);
    expect(reboundThreadId).toBe("source-thread");
  });

  test("rewinds to a later user message by reverting before its turn", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", "turn-first"],
        ["codex-second", "turn-second"],
        ["codex-third", "turn-third"],
      ]),
    );

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-second",
      userMessageTurns,
      setThreadId: () => undefined,
    });

    expect(codex.recordedReverts).toEqual([
      { threadId: "source-thread", beforeTurnId: "turn-second" },
    ]);
  });

  test("hands the revert pagination cursor to the thread rebound", async () => {
    const codex = new FakeCodex((params) => ({
      thread: { id: params.threadId, sessionId: "source-session", turns: [] },
      turnsBackwardsCursor: "cursor-42",
      itemsBackwardsCursor: null,
    }));
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", "turn-first"],
        ["codex-second", "turn-second"],
      ]),
    );
    const rebound: Array<{ threadId: string; turnsBackwardsCursor?: string | null }> = [];

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-second",
      userMessageTurns,
      setThreadId: (threadId, options) => {
        rebound.push({ threadId, turnsBackwardsCursor: options?.turnsBackwardsCursor });
      },
    });

    expect(rebound).toEqual([{ threadId: "source-thread", turnsBackwardsCursor: "cursor-42" }]);
  });

  test("declines to rewind a message whose turn is unknown instead of falling back", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(new Map([["codex-first", null]]));

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "codex-first",
        userMessageTurns,
        setThreadId: () => undefined,
      }),
    ).rejects.toThrow("Codex could not resolve the turn for user message codex-first");
    expect(codex.recordedReverts).toEqual([]);
  });

  test("declines to rewind when the user message is not in the Codex thread", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(new Map([["codex-first", "turn-first"]]));

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "missing-message",
        userMessageTurns,
        setThreadId: () => undefined,
      }),
    ).rejects.toThrow("Codex could not find user message missing-message");
    expect(codex.recordedReverts).toEqual([]);
  });

  test("surfaces the Codex error when the binary has no thread/revert", async () => {
    const codex = new FakeCodex(() => {
      throw new CodexAppServerRpcError("Method not found: thread/revert", -32601, null);
    });
    const userMessageTurns = new CodexMessageTurns(new Map([["codex-first", "turn-first"]]));

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "codex-first",
        userMessageTurns,
        setThreadId: () => undefined,
      }),
    ).rejects.toThrow("Method not found: thread/revert");
  });

  test("declines to rewind before the thread exists", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(new Map([["codex-first", "turn-first"]]));

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: null,
        messageId: "codex-first",
        userMessageTurns,
        setThreadId: () => undefined,
      }),
    ).rejects.toThrow("Codex thread is not ready for rewind");
  });
});
