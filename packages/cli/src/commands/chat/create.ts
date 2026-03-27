import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { connectChatClient, toChatCommandError, type ChatCommandOptions } from "./shared.js";
import { chatRoomSchema, type ChatRoomRow, toChatRoomRow } from "./schema.js";

export interface ChatCreateOptions extends ChatCommandOptions {
  purpose?: string;
}

export async function runCreateCommand(
  name: string,
  options: ChatCreateOptions,
  _command: Command,
): Promise<SingleResult<ChatRoomRow>> {
  const { client } = await connectChatClient(options.host);
  try {
    const payload = await client.createChatRoom({
      name,
      purpose: options.purpose,
    });
    return {
      type: "single",
      data: toChatRoomRow(payload.room!),
      schema: chatRoomSchema,
    };
  } catch (err) {
    throw toChatCommandError("CHAT_CREATE_FAILED", "create chat room", err);
  } finally {
    await client.close().catch(() => {});
  }
}
