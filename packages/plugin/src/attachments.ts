import { z } from "zod";

export const PluginAttachmentItemSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  url: z.url(),
  text: z.string(),
  resourceType: z.string(),
});

export const PluginAttachmentSearchPayloadSchema = z.object({
  items: z.array(PluginAttachmentItemSchema),
});

export type PluginAttachmentItem = z.infer<typeof PluginAttachmentItemSchema>;
export type PluginAttachmentSearchPayload = z.infer<typeof PluginAttachmentSearchPayloadSchema>;
