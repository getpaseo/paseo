import type {
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadRollbackParams,
  CodexThreadRollbackResponse,
} from "./app-server-transport.js";
import {
  parseCodexThreadForkResponse,
  parseCodexThreadRollbackResponse,
} from "./app-server-transport.js";
import { readCodexThreadHistoryMode } from "./thread-history.js";

export interface CodexRewindClient {
  forkThread?(params: CodexThreadForkParams): Promise<CodexThreadForkResponse>;
  rollbackThread?(params: CodexThreadRollbackParams): Promise<CodexThreadRollbackResponse>;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface CodexUserMessage {
  messageId: string;
  turnId: string | null;
}

async function forkCodexThread(
  client: CodexRewindClient,
  params: CodexThreadForkParams,
): Promise<CodexThreadForkResponse> {
  if (client.forkThread) {
    return client.forkThread(params);
  }
  return parseCodexThreadForkResponse(await client.request("thread/fork", params));
}

async function rollbackCodexThread(
  client: CodexRewindClient,
  params: CodexThreadRollbackParams,
): Promise<CodexThreadRollbackResponse> {
  if (client.rollbackThread) {
    return client.rollbackThread(params);
  }
  return parseCodexThreadRollbackResponse(await client.request("thread/rollback", params));
}

function countTurns(userMessages: readonly CodexUserMessage[]): number {
  return userMessages.filter(
    (message, index) => !message.turnId || message.turnId !== userMessages[index - 1]?.turnId,
  ).length;
}

export async function revertCodexConversation(input: {
  client: CodexRewindClient;
  threadId: string | null;
  messageId: string;
  cwd?: string | null;
  model?: string | null;
  serviceTier?: string | null;
  config?: Record<string, unknown> | null;
  userMessages: readonly CodexUserMessage[];
  threadRollbackAvailable: boolean;
  setThreadId: (threadId: string) => void | Promise<void>;
}): Promise<void> {
  if (!input.threadId) {
    throw new Error("Codex thread is not ready for rewind");
  }

  const targetIndex = input.userMessages.findIndex(
    (message) => message.messageId === input.messageId,
  );
  if (targetIndex === -1) {
    throw new Error(`Codex could not find user message ${input.messageId} in the current thread`);
  }
  const targetTurn = input.userMessages[targetIndex];
  // Codex rewinds whole turns; a steer cannot be removed without the earlier
  // messages of its turn.
  if (targetTurn.turnId && input.userMessages[targetIndex - 1]?.turnId === targetTurn.turnId) {
    throw new Error(
      "Codex cannot rewind a message sent during a turn without removing earlier messages. Select the first message in the turn instead.",
    );
  }
  const numTurns = countTurns(input.userMessages.slice(targetIndex));

  // Codex does not carry the parent thread's config into a fork; without it the
  // forked thread falls back to the default model provider.
  const forkParams: CodexThreadForkParams = {
    threadId: input.threadId,
    cwd: input.cwd ?? null,
    model: input.model ?? null,
    serviceTier: input.serviceTier ?? null,
    ...(input.config ? { config: input.config } : {}),
    // Paseo re-reads the rewound thread through paged history, not the fork reply.
    excludeTurns: true,
    persistExtendedHistory: true,
  };

  if (
    !input.threadRollbackAvailable ||
    (await readCodexThreadHistoryMode(input.client, input.threadId)) === "paginated"
  ) {
    if (!targetTurn.turnId) {
      throw new Error(`Codex could not find the turn containing user message ${input.messageId}`);
    }
    const forked = await forkCodexThread(input.client, {
      ...forkParams,
      beforeTurnId: targetTurn.turnId,
    });
    await input.setThreadId(forked.thread.id);
    return;
  }

  // Legacy threads on Codex before 0.156 fork and then roll back. Fork is
  // non-destructive: the old thread file stays on disk and remains
  // recoverable with `codex resume <old-uuid>` if the rewind target was wrong.
  const forked = await forkCodexThread(input.client, forkParams);
  const forkedThreadId = forked.thread.id;

  // Codex rollback is chat-only by design. File edits from rewound turns stay
  // on disk; a future file primitive would be a separate capability.
  const rolledBack = await rollbackCodexThread(input.client, {
    threadId: forkedThreadId,
    numTurns,
  });
  await input.setThreadId(rolledBack.thread.id);
}
