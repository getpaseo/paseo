import {
  AgentTimelineItemPayloadSchema,
  ProviderSubagentDescriptorPayloadSchema,
} from "@getpaseo/protocol/messages";
import { z } from "zod";

export const PLUGIN_SUBAGENT_MAX_EVENT_BYTES = 64 * 1024;

const childId = z.string().min(1).max(256);
const timestamp = z.iso.datetime({ offset: true }).optional();
const presentation = ProviderSubagentDescriptorPayloadSchema.pick({
  title: true,
  description: true,
  status: true,
  toolCallId: true,
  cwd: true,
  subtitle: true,
}).partial();

export const PluginSubagentEventSchema = z.discriminatedUnion("type", [
  presentation
    .extend({
      type: z.literal("upsert"),
      id: childId,
      parentSubagentId: childId.nullable().optional(),
      timestamp,
    })
    .strict(),
  z
    .object({
      type: z.literal("timeline"),
      id: childId,
      item: AgentTimelineItemPayloadSchema,
      timestamp,
    })
    .strict(),
  z.object({ type: z.literal("remove"), id: childId }).strict(),
]);

export type PluginSubagentEvent = z.infer<typeof PluginSubagentEventSchema>;
