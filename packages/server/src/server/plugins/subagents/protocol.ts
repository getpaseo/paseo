import {
  PluginSubagentEventSchema,
  PLUGIN_SUBAGENT_MAX_EVENT_BYTES,
} from "@getpaseo/plugin/server";
import { z } from "zod";

const id = z.string().uuid();
export const PluginSubagentRequestSchema = z
  .object({
    type: z.literal("subagents.request"),
    requestId: id,
    reporterId: id,
    operation: z.discriminatedUnion("type", [
      z.object({ type: z.literal("open"), parentAgentId: z.string().min(1).max(256) }).strict(),
      z
        .object({
          type: z.literal("report"),
          sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          event: PluginSubagentEventSchema,
        })
        .strict(),
      z.object({ type: z.literal("close") }).strict(),
    ]),
  })
  .strict();

export const PluginSubagentResponseSchema = z
  .object({
    type: z.literal("subagents.response"),
    requestId: id,
    error: z.string().nullable(),
  })
  .strict();

export type PluginSubagentRequest = z.infer<typeof PluginSubagentRequestSchema>;
export type PluginSubagentResponse = z.infer<typeof PluginSubagentResponseSchema>;

export function parseSubagentEvent(event: unknown) {
  const encoded = JSON.stringify(event);
  if (encoded === undefined || Buffer.byteLength(encoded) > PLUGIN_SUBAGENT_MAX_EVENT_BYTES) {
    throw new Error(`Subagent event exceeds ${PLUGIN_SUBAGENT_MAX_EVENT_BYTES} bytes`);
  }
  return PluginSubagentEventSchema.parse(JSON.parse(encoded));
}

export function subagentRequestId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (Reflect.get(value, "type") !== "subagents.request") return null;
  const result = id.safeParse(Reflect.get(value, "requestId"));
  return result.success ? result.data : null;
}

export function assertSubagentRequestSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > PLUGIN_SUBAGENT_MAX_EVENT_BYTES + 4096) {
    throw new Error("Subagent IPC request exceeds its payload limit");
  }
}
