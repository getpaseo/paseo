import { z } from "zod";

export const ChatRoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ChatRoom = z.infer<typeof ChatRoomSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  authorAgentId: z.string(),
  body: z.string(),
  replyToMessageId: z.string().nullable(),
  mentionAgentIds: z.array(z.string()),
  createdAt: z.string(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRoomDetailSchema = ChatRoomSchema.extend({
  messageCount: z.number().int().nonnegative(),
  lastMessageAt: z.string().nullable(),
});

export type ChatRoomDetail = z.infer<typeof ChatRoomDetailSchema>;
