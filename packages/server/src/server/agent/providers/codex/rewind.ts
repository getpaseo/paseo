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
import { readCodexThreadHistory, readCodexThreadHistoryMode } from "./thread-history.js";

export interface CodexRewindClient {
  forkThread?(params: CodexThreadForkParams): Promise<CodexThreadForkResponse>;
  rollbackThread?(params: CodexThreadRollbackParams): Promise<CodexThreadRollbackResponse>;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface CodexUserMessageTurnIndex {
  resolve(messageId: string): { index: number; turnId: string | null } | null;
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

/** The settings a fork must carry over; Codex does not copy them from the parent thread. */
interface CodexForkSettings {
  cwd?: string | null;
  model?: string | null;
  serviceTier?: string | null;
  config?: Record<string, unknown> | null;
  developerInstructions?: string;
  threadRollbackAvailable: boolean;
}

/**
 * Forks a thread without its last `droppedTurns` turns and returns the new thread id.
 * `firstDroppedTurnId` names the first of them; `target` describes the cut in errors.
 */
async function forkCodexThreadWithoutLastTurns(input: {
  client: CodexRewindClient;
  threadId: string;
  settings: CodexForkSettings;
  droppedTurns: number;
  firstDroppedTurnId: string | null;
  target: string;
}): Promise<string> {
  const { client, settings } = input;
  // Codex does not carry the parent thread's config into a fork; without it the
  // forked thread falls back to the default model provider.
  const forkParams: CodexThreadForkParams = {
    threadId: input.threadId,
    cwd: settings.cwd ?? null,
    model: settings.model ?? null,
    serviceTier: settings.serviceTier ?? null,
    ...(settings.config ? { config: settings.config } : {}),
    ...(settings.developerInstructions
      ? { developerInstructions: settings.developerInstructions }
      : {}),
    // Paseo re-reads the forked thread through paged history, not the fork reply.
    excludeTurns: true,
    persistExtendedHistory: true,
  };

  if (input.droppedTurns === 0) {
    return (await forkCodexThread(client, forkParams)).thread.id;
  }

  if (
    !settings.threadRollbackAvailable ||
    (await readCodexThreadHistoryMode(client, input.threadId)) === "paginated"
  ) {
    if (!input.firstDroppedTurnId) {
      throw new Error(`Codex could not find the turn containing ${input.target}`);
    }
    const forked = await forkCodexThread(client, {
      ...forkParams,
      beforeTurnId: input.firstDroppedTurnId,
    });
    return forked.thread.id;
  }

  // Legacy threads on Codex before 0.156 fork and then roll back. Fork is
  // non-destructive: the old thread file stays on disk and remains
  // recoverable with `codex resume <old-uuid>` if the rewind target was wrong.
  const forked = await forkCodexThread(client, forkParams);

  // Codex rollback is chat-only by design. File edits from rewound turns stay
  // on disk; a future file primitive would be a separate capability.
  const rolledBack = await rollbackCodexThread(client, {
    threadId: forked.thread.id,
    numTurns: input.droppedTurns,
  });
  return rolledBack.thread.id;
}

export async function revertCodexConversation(
  input: CodexForkSettings & {
    client: CodexRewindClient;
    threadId: string | null;
    messageId: string;
    userMessageTurns: CodexUserMessageTurnIndex;
    setThreadId: (threadId: string) => void | Promise<void>;
  },
): Promise<void> {
  if (!input.threadId) {
    throw new Error("Codex thread is not ready for rewind");
  }

  const targetTurn = input.userMessageTurns.resolve(input.messageId);
  if (targetTurn === null) {
    throw new Error(`Codex could not find user message ${input.messageId} in the current thread`);
  }

  const currentUserTurnCount = input.userMessageTurns.count();
  const numTurns = currentUserTurnCount - targetTurn.index;
  if (numTurns < 0) {
    throw new Error(`Codex user message ${input.messageId} is outside the current thread`);
  }

  const threadId = await forkCodexThreadWithoutLastTurns({
    client: input.client,
    threadId: input.threadId,
    settings: input,
    droppedTurns: numTurns,
    firstDroppedTurnId: targetTurn.turnId,
    target: `user message ${input.messageId}`,
  });
  await input.setThreadId(threadId);
}

/**
 * Forks the thread through the turn holding the assistant message and returns the new
 * thread id. Paseo's assistant message id is the Codex item id.
 */
export async function branchCodexConversation(
  input: CodexForkSettings & {
    client: CodexRewindClient;
    threadId: string;
    messageId: string;
  },
): Promise<string> {
  const turnsAfter = await readCodexTurnsAfterItem(input.client, input.threadId, input.messageId);
  if (turnsAfter === null) {
    throw new Error(`Codex fork target ${input.messageId} is not in the thread`);
  }
  return forkCodexThreadWithoutLastTurns({
    client: input.client,
    threadId: input.threadId,
    settings: input,
    droppedTurns: turnsAfter.length,
    firstDroppedTurnId: turnsAfter[0] ?? null,
    target: `assistant message ${input.messageId}`,
  });
}

/** The ids of the turns after the one holding `itemId`, in order; null when no turn holds it. */
async function readCodexTurnsAfterItem(
  client: CodexRewindClient,
  threadId: string,
  itemId: string,
): Promise<string[] | null> {
  const { rows } = await readCodexThreadHistory(client, threadId);
  const turnIds: string[] = [];
  let holdingTurn: number | null = null;
  for await (const row of rows) {
    if (!row.turnId) {
      throw new Error(`Codex history for thread ${threadId} has an item without a turn id`);
    }
    if (turnIds.at(-1) !== row.turnId) turnIds.push(row.turnId);
    if (holdingTurn === null && readItemId(row.item) === itemId) holdingTurn = turnIds.length - 1;
  }
  return holdingTurn === null ? null : turnIds.slice(holdingTurn + 1);
}

function readItemId(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const id = (item as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}
