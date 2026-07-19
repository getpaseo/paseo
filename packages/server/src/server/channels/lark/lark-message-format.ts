export interface NormalizedLarkMessageEvent {
  eventId: string;
  messageId: string;
  chatId: string;
  threadId: string | null;
  rootMessageId: string | null;
  openId: string | null;
  unionId: string | null;
  displayName: string;
  topicName: string;
  text: string;
}

const MAX_LARK_TEXT_CHARS = 3000;
const MAX_TOPIC_NAME_CHARS = 60;
const SENTENCE_TERMINATORS = new Set(["。", "！", "？", "!", "?"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getRecord(root: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return asRecord(root[key]);
}

function getString(root: Record<string, unknown>, key: string): string | null {
  const value = root[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getStringByKeys(root: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = getString(root, key);
    if (value) {
      return value;
    }
  }
  return null;
}

function parseContentText(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      return null;
    }
    return getString(record, "text")?.trim() ?? null;
  } catch {
    return raw.trim().length > 0 ? raw.trim() : null;
  }
}

function truncateTopicName(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_TOPIC_NAME_CHARS) {
    return singleLine;
  }
  return `${singleLine.slice(0, MAX_TOPIC_NAME_CHARS - 1)}…`;
}

function findFirstSentenceEnd(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (SENTENCE_TERMINATORS.has(char)) {
      return index;
    }
    if (char === "." && (index === text.length - 1 || /\s/.test(text[index + 1] ?? ""))) {
      return index;
    }
  }
  return -1;
}

function deriveTopicNameFromText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  const sentenceEnd = findFirstSentenceEnd(singleLine);
  const firstSentence = sentenceEnd >= 0 ? singleLine.slice(0, sentenceEnd).trim() : singleLine;
  return truncateTopicName(firstSentence || singleLine);
}

function getTopicName(message: Record<string, unknown>, text: string): string {
  return (
    getStringByKeys(message, ["topic_name", "topicName", "thread_name", "threadName"]) ??
    deriveTopicNameFromText(text)
  );
}

function getSenderParts(root: Record<string, unknown>): {
  senderId: Record<string, unknown>;
  displayName: string;
} {
  const sender = getRecord(root, "sender") ?? {};
  return {
    senderId: getRecord(sender, "sender_id") ?? getRecord(sender, "senderId") ?? {},
    displayName: getStringByKeys(sender, ["sender_name", "senderName"]) ?? "Lark user",
  };
}

function getMessageIdentity(message: Record<string, unknown>): {
  chatId: string | null;
  messageId: string | null;
  threadId: string | null;
  rootMessageId: string | null;
} {
  return {
    chatId: getStringByKeys(message, ["chat_id", "chatId"]),
    messageId: getStringByKeys(message, ["message_id", "messageId"]),
    threadId: getStringByKeys(message, ["thread_id", "threadId"]),
    rootMessageId: getStringByKeys(message, ["root_id", "rootId", "parent_id", "parentId"]),
  };
}

export function normalizeLarkMessageEvent(event: unknown): NormalizedLarkMessageEvent | null {
  const root = asRecord(event);
  if (!root) {
    return null;
  }
  const eventId = getStringByKeys(root, ["event_id", "eventId"]) ?? "unknown";
  const message = getRecord(root, "message");
  if (!message) {
    return null;
  }
  const messageType = getStringByKeys(message, ["message_type", "messageType"]);
  if (messageType && messageType !== "text") {
    return null;
  }
  const identity = getMessageIdentity(message);
  const text = parseContentText(getString(message, "content"));
  if (!identity.chatId || !identity.messageId || !text) {
    return null;
  }
  const sender = getSenderParts(root);
  return {
    eventId,
    messageId: identity.messageId,
    chatId: identity.chatId,
    threadId: identity.threadId,
    rootMessageId: identity.rootMessageId,
    openId: getStringByKeys(sender.senderId, ["open_id", "openId"]),
    unionId: getStringByKeys(sender.senderId, ["union_id", "unionId"]),
    displayName: sender.displayName,
    topicName: getTopicName(message, text),
    text,
  };
}

export function formatLarkUserPrompt(event: NormalizedLarkMessageEvent): string {
  return `Message from Lark user ${event.displayName} in chat ${event.chatId} (${event.topicName}):\n\n${event.text}`;
}

export function splitLarkText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_LARK_TEXT_CHARS) {
    return trimmed.length > 0 ? [trimmed] : [];
  }
  const chunks: string[] = [];
  for (let start = 0; start < trimmed.length; start += MAX_LARK_TEXT_CHARS) {
    chunks.push(trimmed.slice(start, start + MAX_LARK_TEXT_CHARS));
  }
  return chunks;
}

export function getLarkEventDedupeKey(event: NormalizedLarkMessageEvent): string {
  return `${event.eventId}:${event.threadId ?? "no-thread"}:${event.messageId}`;
}
