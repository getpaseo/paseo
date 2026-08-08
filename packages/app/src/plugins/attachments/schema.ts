import { z } from "zod";

export const PluginAttachmentItemSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().min(1).optional(),
  url: z.string().url(),
  text: z.string().min(1),
  resourceType: z.string().min(1),
});

export const PluginAttachmentSearchPayloadSchema = z.object({
  items: z.array(PluginAttachmentItemSchema),
});

export type PluginAttachmentItem = z.infer<typeof PluginAttachmentItemSchema>;
export type PluginAttachmentSearchPayload = z.infer<typeof PluginAttachmentSearchPayloadSchema>;
