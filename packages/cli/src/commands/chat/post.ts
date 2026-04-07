import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import {
  attachAgentNamesToMessages,
  connectChatClient,
  resolveChatAuthorAgentId,
  toChatCommandError,
  type ChatCommandOptions,
} from "./shared.js";
import { chatMessageSchema, type ChatMessageRow, toChatMessageRow } from "./schema.js";

export interface ChatPostOptions extends ChatCommandOptions {
  replyTo?: string;
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
      authorAgentId: resolveChatAuthorAgentId(),
      replyToMessageId: options.replyTo,
    });
    const [message] = await attachAgentNamesToMessages(client, [
      toChatMessageRow(payload.message!),
    ]);
    return {
      type: "single",
      data: message!,
      schema: chatMessageSchema,
    };
  } catch (err) {
    throw toChatCommandError("CHAT_POST_FAILED", "post chat message", err);
  } finally {
    await client.close().catch(() => {});
  }
}
