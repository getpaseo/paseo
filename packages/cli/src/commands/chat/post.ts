import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import {
  connectChatClient,
  toChatCommandError,
  type ChatCommandOptions,
} from "./shared.js";
import { chatMessageSchema, type ChatMessageRow, toChatMessageRow } from "./schema.js";

export interface ChatPostOptions extends ChatCommandOptions {
  replyTo?: string;
  mention?: string[];
}

export async function runPostCommand(
  room: string,
  body: string,
  options: ChatPostOptions,
  _command: Command,
): Promise<SingleResult<ChatMessageRow>> {
  const { client } = await connectChatClient(options.host);
  try {
    const payload = await client.postChatMessage({
      room,
      body,
      replyToMessageId: options.replyTo,
      mentionAgentIds: options.mention ?? [],
    });
    return {
      type: "single",
      data: toChatMessageRow(payload.message!),
      schema: chatMessageSchema,
    };
  } catch (err) {
    throw toChatCommandError("CHAT_POST_FAILED", "post chat message", err);
  } finally {
    await client.close().catch(() => {});
  }
}
