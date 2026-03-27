import type { OutputSchema } from "../../output/index.js";

export interface ChatRoomRow {
  name: string;
  id: string;
  purpose: string;
  messages: number;
  lastMessageAt: string;
}

export interface ChatMessageRow {
  id: string;
  author: string;
  createdAt: string;
  replyTo: string;
  mentions: string;
  body: string;
}

export const chatRoomSchema: OutputSchema<ChatRoomRow> = {
  idField: "id",
  columns: [
    { header: "NAME", field: "name", width: 22 },
    { header: "ID", field: "id", width: 36 },
    { header: "PURPOSE", field: "purpose", width: 30 },
    { header: "MESSAGES", field: "messages", width: 10, align: "right" },
    { header: "LAST MESSAGE", field: "lastMessageAt", width: 24 },
  ],
};

export const chatMessageSchema: OutputSchema<ChatMessageRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 36 },
    { header: "AUTHOR", field: "author", width: 16 },
    { header: "CREATED", field: "createdAt", width: 24 },
    { header: "REPLY TO", field: "replyTo", width: 36 },
    { header: "MENTIONS", field: "mentions", width: 24 },
    { header: "MESSAGE", field: "body", width: 60 },
  ],
};

export function toChatRoomRow(room: {
  id: string;
  name: string;
  purpose: string | null;
  messageCount: number;
  lastMessageAt: string | null;
}): ChatRoomRow {
  return {
    id: room.id,
    name: room.name,
    purpose: room.purpose ?? "-",
    messages: room.messageCount,
    lastMessageAt: room.lastMessageAt ?? "-",
  };
}

export function toChatMessageRow(message: {
  id: string;
  authorAgentId: string;
  createdAt: string;
  replyToMessageId: string | null;
  mentionAgentIds: string[];
  body: string;
}): ChatMessageRow {
  return {
    id: message.id,
    author: message.authorAgentId,
    createdAt: message.createdAt,
    replyTo: message.replyToMessageId ?? "-",
    mentions: message.mentionAgentIds.length > 0 ? message.mentionAgentIds.join(",") : "-",
    body: message.body,
  };
}
