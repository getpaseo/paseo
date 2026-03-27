import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  connectChatClient,
  parseSinceValue,
  toChatCommandError,
  type ChatCommandOptions,
} from "./shared.js";
import { chatMessageSchema, type ChatMessageRow, toChatMessageRow } from "./schema.js";

export interface ChatReadOptions extends ChatCommandOptions {
  limit?: string;
  since?: string;
  agent?: string;
}

function parseLimit(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw {
      code: "INVALID_LIMIT",
      message: "Invalid --limit value",
      details: "Use a non-negative integer.",
    };
  }
  return parsed;
}

export async function runReadCommand(
  room: string,
  options: ChatReadOptions,
  _command: Command,
): Promise<ListResult<ChatMessageRow>> {
  const { client } = await connectChatClient(options.host);
  try {
    const payload = await client.readChatMessages({
      room,
      limit: parseLimit(options.limit),
      since: parseSinceValue(options.since),
      authorAgentId: options.agent,
    });
    return {
      type: "list",
      data: payload.messages.map(toChatMessageRow),
      schema: chatMessageSchema,
    };
  } catch (err) {
    throw toChatCommandError("CHAT_READ_FAILED", "read chat messages", err);
  } finally {
    await client.close().catch(() => {});
  }
}
