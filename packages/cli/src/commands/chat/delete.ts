import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { connectChatClient, toChatCommandError, type ChatCommandOptions } from "./shared.js";
import { chatRoomSchema, type ChatRoomRow, toChatRoomRow } from "./schema.js";

export async function runDeleteCommand(
  room: string,
  options: ChatCommandOptions,
  _command: Command,
): Promise<SingleResult<ChatRoomRow>> {
  const { client } = await connectChatClient(options.host);
  try {
    const payload = await client.deleteChatRoom({ room });
    return {
      type: "single",
      data: toChatRoomRow(payload.room!),
      schema: chatRoomSchema,
    };
  } catch (err) {
    throw toChatCommandError("CHAT_DELETE_FAILED", "delete chat room", err);
  } finally {
    await client.close().catch(() => {});
  }
}
