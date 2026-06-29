import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  attachAgentNamesToMessages,
  connectChatClient,
  parseTimeoutMs,
  toChatCommandError,
  type ChatCommandOptions,
} from "./shared.js";
import { chatMessageSchema, type ChatMessageRow, toChatMessageRow } from "./schema.js";

export interface ChatWaitOptions extends ChatCommandOptions {
  timeout?: string;
}

const CHAT_WAIT_PREFLIGHT_TIMEOUT_MS = 2000;

export async function runWaitCommand(
  room: string,
  options: ChatWaitOptions,
  _command: Command,
): Promise<ListResult<ChatMessageRow>> {
  const timeoutMs = parseTimeoutMs(options.timeout);
  const { client } = await connectChatClient(options.host);
  const deadline = typeof timeoutMs === "number" ? Date.now() + timeoutMs : null;
  const hasExplicitTimeout = deadline !== null;
  const remainingTimeoutMs = () =>
    deadline === null ? undefined : Math.max(1, deadline - Date.now());
  try {
    const latest = await client.readChatMessages({
      room,
      limit: 1,
      ...(hasExplicitTimeout
        ? {
            timeout: Math.min(remainingTimeoutMs() ?? 1, CHAT_WAIT_PREFLIGHT_TIMEOUT_MS),
          }
        : {}),
    });
    const afterMessageId = latest.messages[0]?.id;
    const payload = await client.waitForChatMessages({
      room,
      afterMessageId,
      timeoutMs: remainingTimeoutMs() ?? timeoutMs,
    });
    const messages = await attachAgentNamesToMessages(
      client,
      payload.messages.map(toChatMessageRow),
      hasExplicitTimeout
        ? {
            timeout: remainingTimeoutMs(),
            bestEffort: true,
          }
        : {},
    );
    return {
      type: "list",
      data: messages,
      schema: chatMessageSchema,
    };
  } catch (err) {
    throw toChatCommandError("CHAT_WAIT_FAILED", "wait for chat messages", err);
  } finally {
    await client.close().catch(() => {});
  }
}
