import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import {
  ChatMessageSchema,
  ChatRoomDetailSchema,
  ChatRoomSchema,
  type ChatMessage,
  type ChatRoom,
  type ChatRoomDetail,
} from "./chat-types.js";

const ChatStorePayloadSchema = z.object({
  rooms: z.array(ChatRoomSchema),
  messages: z.array(ChatMessageSchema),
});

type ChatStorePayload = z.infer<typeof ChatStorePayloadSchema>;

function normalizeRoomName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const CHAT_MENTION_PATTERN = /(?:^|[\s(])@([A-Za-z0-9][A-Za-z0-9._-]*)/g;

export function parseMentionAgentIds(body: string): string[] {
  const mentionAgentIds = new Set<string>();
  for (const match of body.matchAll(CHAT_MENTION_PATTERN)) {
    const agentId = match[1]?.trim();
    if (agentId) {
      mentionAgentIds.add(agentId);
    }
  }
  return Array.from(mentionAgentIds).sort();
}

export class ChatServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ChatServiceError";
    this.code = code;
  }
}

interface Waiter {
  roomId: string;
  afterMessageId: string | null;
  resolve: (messages: ChatMessage[]) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
}

export interface CreateChatRoomInput {
  name: string;
  purpose?: string | null;
}

export interface InspectChatRoomInput {
  room: string;
}

export interface DeleteChatRoomInput {
  room: string;
}

export interface PostChatMessageInput {
  room: string;
  authorAgentId: string;
  body: string;
  replyToMessageId?: string | null;
}

export interface ReadChatMessagesInput {
  room: string;
  limit?: number;
  since?: string;
  authorAgentId?: string;
}

export interface ListChatRoomPosterAgentIdsInput {
  room: string;
}

export interface WaitForChatMessagesInput {
  room: string;
  afterMessageId?: string | null;
  timeoutMs?: number;
}

export interface DeleteChatRoomResult {
  room: ChatRoomDetail;
}

export interface InspectChatRoomResult {
  room: ChatRoomDetail;
}

export class FileBackedChatService {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  private loaded = false;
  private readonly rooms = new Map<string, ChatRoom>();
  private readonly messagesByRoomId = new Map<string, ChatMessage[]>();
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly waitersByRoomId = new Map<string, Set<Waiter>>();

  constructor(options: { paseoHome: string; logger: pino.Logger }) {
    this.filePath = path.join(options.paseoHome, "chat", "rooms.json");
    this.logger = options.logger.child({ component: "chat-service" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async createRoom(input: CreateChatRoomInput): Promise<ChatRoomDetail> {
    await this.load();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new ChatServiceError("invalid_chat_room_name", "Chat room name is required");
    }
    if (this.findRoomByName(name)) {
      throw new ChatServiceError(
        "chat_room_name_taken",
        `Chat room already exists with name: ${name}`,
      );
    }

    const now = new Date().toISOString();
    const room = ChatRoomSchema.parse({
      id: randomUUID(),
      name,
      purpose: trimToNull(input.purpose),
      createdAt: now,
      updatedAt: now,
    });
    this.rooms.set(room.id, room);
    await this.enqueuePersist();
    return this.toRoomDetail(room);
  }

  async listRooms(): Promise<ChatRoomDetail[]> {
    await this.load();
    return Array.from(this.rooms.values())
      .map((room) => this.toRoomDetail(room))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async inspectRoom(input: InspectChatRoomInput): Promise<InspectChatRoomResult> {
    await this.load();
    const room = this.resolveRoom(input.room);
    return {
      room: this.toRoomDetail(room),
    };
  }

  async deleteRoom(input: DeleteChatRoomInput): Promise<DeleteChatRoomResult> {
    await this.load();
    const room = this.resolveRoom(input.room);
    const detail = this.toRoomDetail(room);
    this.rooms.delete(room.id);
    this.messagesByRoomId.delete(room.id);
    await this.enqueuePersist();
    this.rejectWaiters(
      room.id,
      new ChatServiceError("chat_room_deleted", `Chat room deleted: ${room.name}`),
    );
    return { room: detail };
  }

  async dispatchMessage(input: PostChatMessageInput): Promise<ChatMessage> {
    await this.load();
    const room = this.resolveRoom(input.room);
    const body = input.body.trim();
    if (body.length === 0) {
      throw new ChatServiceError("invalid_chat_message", "Chat message body is required");
    }
    const authorAgentId = input.authorAgentId.trim();
    if (authorAgentId.length === 0) {
      throw new ChatServiceError("invalid_chat_author", "Chat message author is required");
    }

    const messages = this.getRoomMessages(room.id);
    const replyToMessageId = trimToNull(input.replyToMessageId);
    if (replyToMessageId) {
      const replyTarget = messages.find((message) => message.id === replyToMessageId);
      if (!replyTarget) {
        throw new ChatServiceError(
          "chat_message_not_found",
          `Reply target not found: ${replyToMessageId}`,
        );
      }
    }

    const createdAt = new Date().toISOString();
    const message = ChatMessageSchema.parse({
      id: randomUUID(),
      roomId: room.id,
      authorAgentId,
      body,
      replyToMessageId,
      mentionAgentIds: parseMentionAgentIds(body),
      createdAt,
    });

    messages.push(message);
    this.messagesByRoomId.set(room.id, messages);
    this.rooms.set(
      room.id,
      ChatRoomSchema.parse({
        ...room,
        updatedAt: createdAt,
      }),
    );
    await this.enqueuePersist();
    this.notifyWaiters(room.id);
    return message;
  }

  async readMessages(input: ReadChatMessagesInput): Promise<ChatMessage[]> {
    await this.load();
    const room = this.resolveRoom(input.room);
    const messages = [...this.getRoomMessages(room.id)];
    const since = trimToNull(input.since);
    const authorAgentId = trimToNull(input.authorAgentId);
    const limit = this.normalizeLimit(input.limit);

    const filtered = messages.filter((message) => {
      if (since && message.createdAt < since) {
        return false;
      }
      if (authorAgentId && message.authorAgentId !== authorAgentId) {
        return false;
      }
      return true;
    });

    if (limit === 0 || filtered.length <= limit) {
      return filtered;
    }
    return filtered.slice(filtered.length - limit);
  }

  async listRoomPosterAgentIds(input: ListChatRoomPosterAgentIdsInput): Promise<string[]> {
    await this.load();
    const room = this.resolveRoom(input.room);
    const posters = new Set<string>();
    for (const message of this.getRoomMessages(room.id)) {
      posters.add(message.authorAgentId);
    }
    return Array.from(posters);
  }

  async waitForMessages(input: WaitForChatMessagesInput): Promise<ChatMessage[]> {
    await this.load();
    const room = this.resolveRoom(input.room);
    const timeoutMs = Math.max(0, Math.floor(input.timeoutMs ?? 0));
    const afterMessageId = trimToNull(input.afterMessageId);

    if (afterMessageId) {
      const existing = this.selectMessagesAfter(room.id, afterMessageId);
      if (existing.length > 0) {
        return existing;
      }
      const knownMessage = this.getRoomMessages(room.id).some(
        (message) => message.id === afterMessageId,
      );
      if (!knownMessage) {
        throw new ChatServiceError(
          "chat_message_not_found",
          `Wait cursor not found: ${afterMessageId}`,
        );
      }
    }

    return new Promise<ChatMessage[]>((resolve, reject) => {
      const waiter: Waiter = {
        roomId: room.id,
        afterMessageId,
        resolve: (messages) => {
          if (waiter.timeout) {
            clearTimeout(waiter.timeout);
            waiter.timeout = null;
          }
          this.removeWaiter(waiter);
          resolve(messages);
        },
        reject: (error) => {
          if (waiter.timeout) {
            clearTimeout(waiter.timeout);
            waiter.timeout = null;
          }
          this.removeWaiter(waiter);
          reject(error);
        },
        timeout: null,
      };

      if (timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          waiter.resolve([]);
        }, timeoutMs);
      }

      const roomWaiters = this.waitersByRoomId.get(room.id) ?? new Set<Waiter>();
      roomWaiters.add(waiter);
      this.waitersByRoomId.set(room.id, roomWaiters);
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.rooms.clear();
    this.messagesByRoomId.clear();

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = ChatStorePayloadSchema.parse(JSON.parse(raw));
      for (const room of parsed.rooms) {
        this.rooms.set(room.id, room);
      }
      for (const message of parsed.messages) {
        const messages = this.messagesByRoomId.get(message.roomId) ?? [];
        messages.push(message);
        this.messagesByRoomId.set(message.roomId, messages);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, filePath: this.filePath }, "Failed to load chat store");
      }
    }

    this.loaded = true;
  }

  private async enqueuePersist(): Promise<void> {
    const nextPersist = this.persistQueue.then(() => this.persist());
    this.persistQueue = nextPersist.catch(() => {});
    await nextPersist;
  }

  private async persist(): Promise<void> {
    const payload: ChatStorePayload = {
      rooms: Array.from(this.rooms.values()).sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
      messages: Array.from(this.messagesByRoomId.values())
        .flat()
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(tempPath, this.filePath);
  }

  private findRoomByName(name: string): ChatRoom | null {
    const normalizedName = normalizeRoomName(name);
    for (const room of this.rooms.values()) {
      if (normalizeRoomName(room.name) === normalizedName) {
        return room;
      }
    }
    return null;
  }

  private resolveRoom(roomSelector: string): ChatRoom {
    const selector = roomSelector.trim();
    if (selector.length === 0) {
      throw new ChatServiceError("invalid_chat_room", "Chat room name or ID is required");
    }
    const byId = this.rooms.get(selector);
    if (byId) {
      return byId;
    }
    const byName = this.findRoomByName(selector);
    if (byName) {
      return byName;
    }
    throw new ChatServiceError("chat_room_not_found", `Chat room not found: ${selector}`);
  }

  private getRoomMessages(roomId: string): ChatMessage[] {
    return this.messagesByRoomId.get(roomId) ?? [];
  }

  private toRoomDetail(room: ChatRoom): ChatRoomDetail {
    const messages = this.getRoomMessages(room.id);
    return ChatRoomDetailSchema.parse({
      ...room,
      messageCount: messages.length,
      lastMessageAt: messages[messages.length - 1]?.createdAt ?? null,
    });
  }

  private normalizeLimit(limit: number | undefined): number {
    if (limit === undefined) {
      return 20;
    }
    const normalized = Math.max(0, Math.floor(limit));
    return normalized;
  }

  private selectMessagesAfter(roomId: string, afterMessageId: string): ChatMessage[] {
    const messages = this.getRoomMessages(roomId);
    const index = messages.findIndex((message) => message.id === afterMessageId);
    if (index === -1) {
      return [];
    }
    return messages.slice(index + 1);
  }

  private notifyWaiters(roomId: string): void {
    const waiters = this.waitersByRoomId.get(roomId);
    if (!waiters || waiters.size === 0) {
      return;
    }

    for (const waiter of Array.from(waiters)) {
      const messages =
        waiter.afterMessageId === null
          ? this.getRoomMessages(roomId).slice(-1)
          : this.selectMessagesAfter(roomId, waiter.afterMessageId);
      if (messages.length === 0) {
        continue;
      }
      waiter.resolve(messages);
    }
  }

  private removeWaiter(waiter: Waiter): void {
    const waiters = this.waitersByRoomId.get(waiter.roomId);
    if (!waiters) {
      return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.waitersByRoomId.delete(waiter.roomId);
    }
  }

  private rejectWaiters(roomId: string, error: Error): void {
    const waiters = this.waitersByRoomId.get(roomId);
    if (!waiters) {
      return;
    }
    for (const waiter of Array.from(waiters)) {
      waiter.reject(error);
    }
  }
}
