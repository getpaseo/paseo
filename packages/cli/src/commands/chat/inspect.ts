import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { connectChatClient, toChatCommandError, type ChatCommandOptions } from "./shared.js";
import { chatRoomSchema, type ChatRoomRow, toChatRoomRow } from "./schema.js";

export async function runInspectCommand(
  room: string,
  options: ChatCommandOptions,
  _command: Command,
): Promise<SingleResult<ChatRoomRow>> {
  const { client } = await connectChatClient(options.host);
  try {
    const payload = await client.inspectChatRoom({ room });
    return {
      type: "single",
      data: toChatRoomRow(payload.room!),
      schema: chatRoomSchema,
    };
  } catch (err) {
    throw toChatCommandError("CHAT_INSPECT_FAILED", "inspect chat room", err);
  } finally {
    await client.close().catch(() => {});
  }
}
