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

export interface CodexRewindClient {
  forkThread?(params: CodexThreadForkParams): Promise<CodexThreadForkResponse>;
  rollbackThread?(params: CodexThreadRollbackParams): Promise<CodexThreadRollbackResponse>;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface CodexUserMessageTurnIndex {
  resolve(messageId: string): number | null;
  count(): number;
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

export async function revertCodexConversation(input: {
  client: CodexRewindClient;
  threadId: string | null;
  messageId: string;
  cwd?: string | null;
  model?: string | null;
  serviceTier?: string | null;
  userMessageTurns: CodexUserMessageTurnIndex;
  setThreadId: (threadId: string) => void | Promise<void>;
}): Promise<void> {
  if (!input.threadId) {
    throw new Error("Codex thread is not ready for rewind");
  }

  const targetTurnIndex = input.userMessageTurns.resolve(input.messageId);
  if (targetTurnIndex === null) {
    throw new Error(`Codex could not find user message ${input.messageId} in the current thread`);
  }

  const currentUserTurnCount = input.userMessageTurns.count();
  const numTurns = currentUserTurnCount - targetTurnIndex;
  if (numTurns < 0) {
    throw new Error(`Codex user message ${input.messageId} is outside the current thread`);
  }

  // Fork is non-destructive: the old thread file stays on disk and remains
  // recoverable with `codex resume <old-uuid>` if the rewind target was wrong.
  const forked = await forkCodexThread(input.client, {
    threadId: input.threadId,
    cwd: input.cwd ?? null,
    model: input.model ?? null,
    serviceTier: input.serviceTier ?? null,
    excludeTurns: false,
    persistExtendedHistory: true,
  });
  const forkedThreadId = forked.thread.id;

  // Codex rollback is chat-only by design. File edits from rewound turns stay
  // on disk; a future file primitive would be a separate capability.
  const rolledBack = await rollbackCodexThread(input.client, {
    threadId: forkedThreadId,
    numTurns,
  });
  await input.setThreadId(rolledBack.thread.id);
}
