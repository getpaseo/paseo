import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  connectChatClient,
  parseTimeoutMs,
  toChatCommandError,
  type ChatCommandOptions,
} from "./shared.js";
import { chatMessageSchema, type ChatMessageRow, toChatMessageRow } from "./schema.js";

export interface ChatWaitOptions extends ChatCommandOptions {
  timeout?: string;
}

export async function runWaitCommand(
  room: string,
  options: ChatWaitOptions,
  _command: Command,
): Promise<ListResult<ChatMessageRow>> {
  const { client } = await connectChatClient(options.host);
  try {
    const latest = await client.readChatMessages({
      room,
      limit: 1,
    });
    const afterMessageId = latest.messages[0]?.id;
    const payload = await client.waitForChatMessages({
      room,
      afterMessageId,
      timeoutMs: parseTimeoutMs(options.timeout),
    });
    return {
      type: "list",
      data: payload.messages.map(toChatMessageRow),
      schema: chatMessageSchema,
    };
  } catch (err) {
    throw toChatCommandError("CHAT_WAIT_FAILED", "wait for chat messages", err);
  } finally {
    await client.close().catch(() => {});
  }
}
