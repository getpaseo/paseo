import { z } from "zod";
import { ChatMessageSchema, ChatRoomDetailSchema } from "./chat-types.js";

export const ChatCreateRequestSchema = z.object({
  type: z.literal("chat/create"),
  requestId: z.string(),
  name: z.string(),
  purpose: z.string().optional(),
});

export const ChatListRequestSchema = z.object({
  type: z.literal("chat/list"),
  requestId: z.string(),
});

export const ChatInspectRequestSchema = z.object({
  type: z.literal("chat/inspect"),
  requestId: z.string(),
  room: z.string(),
});

export const ChatDeleteRequestSchema = z.object({
  type: z.literal("chat/delete"),
  requestId: z.string(),
  room: z.string(),
});

export const ChatPostRequestSchema = z.object({
  type: z.literal("chat/post"),
  requestId: z.string(),
  room: z.string(),
  body: z.string(),
  replyToMessageId: z.string().optional(),
  mentionAgentIds: z.array(z.string()).optional(),
});

export const ChatReadRequestSchema = z.object({
  type: z.literal("chat/read"),
  requestId: z.string(),
  room: z.string(),
  limit: z.number().int().nonnegative().optional(),
  since: z.string().optional(),
  authorAgentId: z.string().optional(),
});

export const ChatWaitRequestSchema = z.object({
  type: z.literal("chat/wait"),
  requestId: z.string(),
  room: z.string(),
  afterMessageId: z.string().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
});

export const ChatCreateResponseSchema = z.object({
  type: z.literal("chat/create/response"),
  payload: z.object({
    requestId: z.string(),
    room: ChatRoomDetailSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ChatListResponseSchema = z.object({
  type: z.literal("chat/list/response"),
  payload: z.object({
    requestId: z.string(),
    rooms: z.array(ChatRoomDetailSchema),
    error: z.string().nullable(),
  }),
});

export const ChatInspectResponseSchema = z.object({
  type: z.literal("chat/inspect/response"),
  payload: z.object({
    requestId: z.string(),
    room: ChatRoomDetailSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ChatDeleteResponseSchema = z.object({
  type: z.literal("chat/delete/response"),
  payload: z.object({
    requestId: z.string(),
    room: ChatRoomDetailSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ChatPostResponseSchema = z.object({
  type: z.literal("chat/post/response"),
  payload: z.object({
    requestId: z.string(),
    message: ChatMessageSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ChatReadResponseSchema = z.object({
  type: z.literal("chat/read/response"),
  payload: z.object({
    requestId: z.string(),
    messages: z.array(ChatMessageSchema),
    error: z.string().nullable(),
  }),
});

export const ChatWaitResponseSchema = z.object({
  type: z.literal("chat/wait/response"),
  payload: z.object({
    requestId: z.string(),
    messages: z.array(ChatMessageSchema),
    timedOut: z.boolean(),
    error: z.string().nullable(),
  }),
});
