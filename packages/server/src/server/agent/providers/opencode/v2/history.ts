import type { SessionMessageInfo } from "@opencode/client";
import type { V2Api } from "./api.js";

export async function messages(client: V2Api, sessionID: string): Promise<SessionMessageInfo[]> {
  const result: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.message.list({
      sessionID,
      ...(cursor ? { cursor } : { order: "asc" }),
      limit: 100,
    });
    result.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  return result;
}
