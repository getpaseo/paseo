import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { connectChatClient, toChatCommandError, type ChatCommandOptions } from "./shared.js";
import { chatRoomSchema, type ChatRoomRow, toChatRoomRow } from "./schema.js";

export async function runLsCommand(
  options: ChatCommandOptions,
  _command: Command,
): Promise<ListResult<ChatRoomRow>> {
  const { client } = await connectChatClient(options.host);
  try {
    const payload = await client.listChatRooms();
    return {
      type: "list",
      data: payload.rooms.map(toChatRoomRow),
      schema: chatRoomSchema,
    };
  } catch (err) {
    throw toChatCommandError("CHAT_LIST_FAILED", "list chat rooms", err);
  } finally {
    await client.close().catch(() => {});
  }
}
