import { z } from "zod";
import { getUserMessageText, type PiCapturedUserMessageEntry } from "./history-mapper.js";
import type { PiAgentMessage } from "./rpc-types.js";

export interface PiTranscript {
  messages: PiAgentMessage[];
  userEntries: PiCapturedUserMessageEntry[];
}

const text = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const image = z
  .object({ type: z.literal("image"), data: z.string(), mimeType: z.string() })
  .passthrough();
const content = z.union([z.string(), z.array(z.union([text, image]))]);
const message = z.discriminatedUnion("role", [
  z
    .object({ role: z.literal("system"), content: z.union([z.string(), z.array(text)]).nullish() })
    .passthrough(),
  z.object({ role: z.literal("branchSummary"), summary: z.string() }).passthrough(),
  z.object({ role: z.literal("compactionSummary"), summary: z.string() }).passthrough(),
  z.object({ role: z.literal("user"), content }).passthrough(),
  z
    .object({
      role: z.literal("custom"),
      content,
      customType: z.string().optional(),
      display: z.boolean().optional(),
      details: z.unknown().optional(),
    })
    .passthrough(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.array(
        z.union([
          text,
          z.object({ type: z.literal("thinking"), thinking: z.string() }).passthrough(),
          z
            .object({
              type: z.literal("toolCall"),
              id: z.string(),
              name: z.string(),
              arguments: z.unknown(),
            })
            .passthrough(),
        ]),
      ),
    })
    .passthrough(),
  z
    .object({
      role: z.literal("toolResult"),
      toolCallId: z.string(),
      toolName: z.string(),
      content: z.unknown(),
      isError: z.boolean().optional(),
      details: z.unknown().optional(),
    })
    .passthrough(),
  z
    .object({
      role: z.literal("bashExecution"),
      command: z.string(),
      output: z.string().optional(),
      exitCode: z.number().nullable().optional(),
      cancelled: z.boolean().optional(),
      timestamp: z.number(),
    })
    .passthrough(),
]);
const record = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    parentId: z.string().nullable().optional(),
    message: z.unknown().optional(),
  })
  .passthrough();

/** Select the persisted active ancestry, retaining structural links across compaction. */
export function readPiTranscript(contents: string): PiTranscript {
  const records = contents
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => record.parse(JSON.parse(line)));
  const header = records.shift();
  if (header?.type !== "session") throw new Error("Pi transcript is missing its session header");
  const legacy = header.version === 1;
  const branch = legacy ? records : activeBranch(records);
  const result: PiTranscript = { messages: [], userEntries: [] };
  for (const entry of branch) {
    if (entry.type !== "message" && entry.type !== "custom_message") continue;
    const parsed = message.parse(
      entry.type === "custom_message" ? { ...entry, role: "custom" } : entry.message,
    );
    // These native context messages had no display mapping in get_messages replay.
    if (
      parsed.role === "system" ||
      parsed.role === "branchSummary" ||
      parsed.role === "compactionSummary"
    )
      continue;
    result.messages.push(parsed);
    if (parsed.role === "user" && entry.id)
      result.userEntries.push({
        id: entry.id,
        text: getUserMessageText(parsed.content),
      });
  }
  return result;
}

function activeBranch(records: z.infer<typeof record>[]): z.infer<typeof record>[] {
  const byId = new Map<string, (typeof records)[number]>();
  for (const entry of records) {
    if (!entry.id || entry.parentId === undefined || byId.has(entry.id))
      throw new Error("Invalid Pi transcript tree entry");
    byId.set(entry.id, entry);
  }
  const branch: z.infer<typeof record>[] = [];
  const seen = new Set<string>();
  let entry = records.at(-1);
  while (entry) {
    const id = entry.id!;
    if (seen.has(id)) throw new Error("Cycle in Pi transcript ancestry");
    seen.add(id);
    branch.push(entry);
    if (entry.parentId === null) break;
    entry = byId.get(entry.parentId!);
    if (!entry) throw new Error("Missing Pi transcript ancestor");
  }
  branch.reverse();
  return branch;
}
