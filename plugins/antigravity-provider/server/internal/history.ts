import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

const record = z.object({
  step_index: z.number().int().nonnegative(),
  created_at: z.string().optional(),
  type: z.enum(["USER_INPUT", "PLANNER_RESPONSE"]),
  content: z.string(),
});

export async function readHistory(input: {
  conversationId: string;
  env: Record<string, string>;
  systemPrompt?: string;
}): Promise<Array<{ item: ProviderTimelineItem; timestamp?: string }>> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.conversationId)) return [];
  const home = (process.platform === "win32" ? input.env.USERPROFILE : input.env.HOME) || homedir();
  const file = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "brain",
    input.conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  let transcript: string;
  try {
    transcript = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const messages: Array<{ item: ProviderTimelineItem; timestamp?: string }> = [];
  for (const line of transcript.split("\n")) {
    const message = parseMessage(line, messages.length === 0 ? input.systemPrompt : undefined);
    if (message) messages.push(message);
  }
  return messages;
}

function parseMessage(
  line: string,
  systemPrompt?: string,
): { item: ProviderTimelineItem; timestamp?: string } | undefined {
  if (!line.trim()) return;
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return;
  }
  const result = record.safeParse(decoded);
  if (!result.success) return;
  const { type, content, step_index, created_at } = result.data;
  const user = type === "USER_INPUT";
  const text = user ? userText(content, systemPrompt) : content;
  if (!text.trim()) return;
  const parsedTimestamp = z.iso.datetime({ offset: true }).safeParse(created_at);
  return {
    timestamp: parsedTimestamp.data,
    item: { type: user ? "user_message" : "assistant_message", id: `history:${step_index}`, text },
  };
}

function userText(content: string, systemPrompt?: string): string {
  const match = /^<USER_REQUEST>\r?\n([\s\S]*)\r?\n<\/USER_REQUEST>(?:\r?\n<|$)/.exec(content);
  const text = match?.[1] ?? content;
  if (!systemPrompt) return text;
  const prefix = `${systemPrompt}\n\n`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}
