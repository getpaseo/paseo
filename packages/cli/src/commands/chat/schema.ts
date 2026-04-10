import type { OutputSchema } from "../../output/index.js";
import type { AnyCommandResult, OutputOptions } from "../../output/index.js";

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
  authorName: string | null;
  createdAt: string;
  replyTo: string;
  mentionAgentIds: string[];
  mentionLabels: string[];
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
    { header: "AUTHOR NAME", field: (row) => row.authorName ?? "-", width: 20 },
    { header: "CREATED", field: "createdAt", width: 24 },
    { header: "REPLY TO", field: "replyTo", width: 36 },
    { header: "MENTIONS", field: (row) => row.mentionLabels.join(", ") || "-", width: 24 },
    { header: "MESSAGE", field: "body", width: 60 },
  ],
  renderHuman: renderChatTranscript,
};

function renderChatTranscript(
  result: AnyCommandResult<ChatMessageRow>,
  _options: OutputOptions,
): string {
  const data = result.type === "list" ? result.data : [result.data];
  if (data.length === 0) {
    return "";
  }
  return data.map(renderChatMessageBlock).join("\n\n");
}

function renderChatMessageBlock(message: ChatMessageRow): string {
  const authorLabel = message.authorName
    ? `${message.authorName} (${message.author})`
    : message.author;
  const lines = [
    `┌─ ${authorLabel} ── ${formatTimestamp(message.createdAt)} ── [msg ${message.id}]`,
  ];

  if (message.replyTo !== "-") {
    lines.push(`│  reply-to: msg ${message.replyTo}`);
  }
  if (message.mentionLabels.length > 0) {
    lines.push(`│  mentions: ${message.mentionLabels.join(", ")}`);
  }

  lines.push("│");

  const bodyLines = message.body.split(/\r?\n/);
  for (const line of bodyLines) {
    lines.push(`│  ${line}`);
  }

  lines.push("│");
  lines.push("└─");
  return lines.join("\n");
}

function formatTimestamp(input: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return input;
  }
  return date.toISOString().replace("T", " ").replace(".000Z", "Z");
}

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
    authorName: null,
    createdAt: message.createdAt,
    replyTo: message.replyToMessageId ?? "-",
    mentionAgentIds: message.mentionAgentIds,
    mentionLabels: message.mentionAgentIds,
    body: message.body,
  };
}
