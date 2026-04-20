import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { attachment, channel, mention, message, reaction, user } from "@/db/schema";
import { ChatError } from "./channels";
import { type DbLike, resolveChannelAccess } from "./authz";
import { newAttachmentId, newMessageId } from "./ids";

export interface MessageAttachmentInput {
  url: string;
  mimeType: string;
  filename: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
}

export interface SendMessageInput {
  channelId: string;
  userId: string;
  content: string;
  parentId?: string | null;
  attachments?: MessageAttachmentInput[];
}

export interface MessageRow {
  id: string;
  channelId: string;
  userId: string;
  parentId: string | null;
  content: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  attachments: Array<{
    id: string;
    url: string;
    mimeType: string;
    filename: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
  }>;
  /** Number of non-deleted direct replies in this message's thread. 0 when not a thread parent. */
  replyCount: number;
  /** Distinct replier user IDs (order of first reply, up to a small cap) so
   * the client can render Slack-style avatar stacks on the thread chip. */
  replyUserIds: string[];
  /**
   * Reactions aggregated per emoji. Empty array when none. Included inline so
   * clients don't need N+1 queries to hydrate reactions on load.
   */
  reactions: Array<{ emoji: string; count: number; userIds: string[] }>;
}

const MENTION_RE = /<@([a-zA-Z0-9_-]+)>/g;

export function extractMentionUserIds(content: string): string[] {
  const found = new Set<string>();
  for (const m of content.matchAll(MENTION_RE)) {
    if (m[1]) found.add(m[1]);
  }
  return Array.from(found);
}

export async function sendMessage(db: DbLike, input: SendMessageInput): Promise<MessageRow> {
  const access = await resolveChannelAccess(db, input.channelId, input.userId);
  if (!access) throw new ChatError("not_found", "Channel not found");
  if (!access.canWrite) throw new ChatError("forbidden", "Cannot write to channel");

  const content = (input.content ?? "").trim();
  if (content.length === 0 && (!input.attachments || input.attachments.length === 0)) {
    throw new ChatError("bad_request", "Message is empty");
  }
  if (content.length > 8000) {
    throw new ChatError("bad_request", "Message too long");
  }

  if (input.parentId) {
    const parentRows = await db
      .select({ channelId: message.channelId, parentId: message.parentId })
      .from(message)
      .where(eq(message.id, input.parentId))
      .limit(1);
    const parent = parentRows[0];
    if (!parent) throw new ChatError("bad_request", "Parent message does not exist");
    if (parent.channelId !== input.channelId) {
      throw new ChatError("bad_request", "Parent message is in a different channel");
    }
    if (parent.parentId !== null) {
      throw new ChatError("bad_request", "Cannot reply to a reply; use the thread root");
    }
  }

  const id = newMessageId();
  const inserted = await db
    .insert(message)
    .values({
      id,
      channelId: input.channelId,
      userId: input.userId,
      parentId: input.parentId ?? null,
      content,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("Insert returned no row");

  const insertedAttachments: MessageRow["attachments"] = [];
  if (input.attachments && input.attachments.length > 0) {
    const attRows = await db
      .insert(attachment)
      .values(
        input.attachments.map((a) => ({
          id: newAttachmentId(),
          messageId: id,
          url: a.url,
          mimeType: a.mimeType,
          filename: a.filename,
          sizeBytes: a.sizeBytes,
          width: a.width ?? null,
          height: a.height ?? null,
        })),
      )
      .returning();
    for (const a of attRows) {
      insertedAttachments.push({
        id: a.id,
        url: a.url,
        mimeType: a.mimeType,
        filename: a.filename,
        sizeBytes: a.sizeBytes,
        width: a.width,
        height: a.height,
      });
    }
  }

  // Register mentions. Filter out userIds that don't exist BEFORE inserting
  // (bad FKs would abort the whole batch). A single SELECT + single INSERT
  // is cheaper than N round-trips in a loop.
  const mentionedIds = extractMentionUserIds(content);
  if (mentionedIds.length > 0) {
    const existing = await db
      .select({ id: user.id })
      .from(user)
      .where(inArray(user.id, mentionedIds));
    const existingIds = existing.map((u) => u.id);
    if (existingIds.length > 0) {
      await db
        .insert(mention)
        .values(existingIds.map((uid) => ({ messageId: id, userId: uid })))
        .onConflictDoNothing();
    }
  }

  return {
    id: row.id,
    channelId: row.channelId,
    userId: row.userId,
    parentId: row.parentId,
    content: row.content,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    attachments: insertedAttachments,
    replyCount: 0,
    replyUserIds: [],
    reactions: [],
  };
}

export async function getMessageById(db: DbLike, messageId: string): Promise<MessageRow | null> {
  const rows = await db.select().from(message).where(eq(message.id, messageId)).limit(1);
  const m = rows[0];
  if (!m) return null;
  const atts = await db.select().from(attachment).where(eq(attachment.messageId, messageId));
  return {
    id: m.id,
    channelId: m.channelId,
    userId: m.userId,
    parentId: m.parentId,
    content: m.content,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
    attachments: atts.map((a) => ({
      id: a.id,
      url: a.url,
      mimeType: a.mimeType,
      filename: a.filename,
      sizeBytes: a.sizeBytes,
      width: a.width,
      height: a.height,
    })),
    replyCount: await countReplies(db, m.id),
    replyUserIds: await distinctReplyUserIds(db, m.id, 5),
    reactions: [],
  };
}

async function countReplies(db: DbLike, parentId: string): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(message)
    .where(and(eq(message.parentId, parentId), isNull(message.deletedAt)));
  return Number(rows[0]?.c ?? 0);
}

async function distinctReplyUserIds(
  db: DbLike,
  parentId: string,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ userId: message.userId, createdAt: message.createdAt })
    .from(message)
    .where(and(eq(message.parentId, parentId), isNull(message.deletedAt)))
    .orderBy(message.createdAt);
  const seen: string[] = [];
  for (const r of rows) {
    if (seen.includes(r.userId)) continue;
    if (seen.length >= limit) break;
    seen.push(r.userId);
  }
  return seen;
}

export interface ListMessagesParams {
  channelId: string;
  userId: string;
  before?: string;
  after?: string;
  limit?: number;
  includeDeleted?: boolean;
}

export async function listMessages(db: DbLike, params: ListMessagesParams): Promise<MessageRow[]> {
  const access = await resolveChannelAccess(db, params.channelId, params.userId);
  if (!access) throw new ChatError("not_found", "Channel not found");
  if (!access.canRead) throw new ChatError("forbidden", "Cannot read channel");

  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);

  let cursor: { createdAt: Date; id: string } | undefined;
  if (params.before) {
    const rows = await db
      .select({ createdAt: message.createdAt, id: message.id })
      .from(message)
      .where(eq(message.id, params.before))
      .limit(1);
    cursor = rows[0];
  } else if (params.after) {
    const rows = await db
      .select({ createdAt: message.createdAt, id: message.id })
      .from(message)
      .where(eq(message.id, params.after))
      .limit(1);
    cursor = rows[0];
  }

  const conditions = [eq(message.channelId, params.channelId), isNull(message.parentId)];
  if (!params.includeDeleted) conditions.push(isNull(message.deletedAt));
  if (cursor && params.before) {
    const beforeCursor = or(
      lt(message.createdAt, cursor.createdAt),
      and(eq(message.createdAt, cursor.createdAt), lt(message.id, cursor.id)),
    );
    if (beforeCursor) conditions.push(beforeCursor);
  }
  if (cursor && params.after) {
    const afterCursor = or(
      gt(message.createdAt, cursor.createdAt),
      and(eq(message.createdAt, cursor.createdAt), gt(message.id, cursor.id)),
    );
    if (afterCursor) conditions.push(afterCursor);
  }

  const rows = await db
    .select()
    .from(message)
    .where(and(...conditions))
    .orderBy(
      params.after ? asc(message.createdAt) : desc(message.createdAt),
      params.after ? asc(message.id) : desc(message.id),
    )
    .limit(limit);

  const ids = rows.map((r) => r.id);
  const attsByMsg = new Map<string, MessageRow["attachments"]>();
  const replyCountByParent = new Map<string, number>();
  const replyUsersByParent = new Map<string, string[]>();
  if (ids.length > 0) {
    const atts = await db.select().from(attachment).where(inArray(attachment.messageId, ids));
    for (const a of atts) {
      const arr = attsByMsg.get(a.messageId) ?? [];
      arr.push({
        id: a.id,
        url: a.url,
        mimeType: a.mimeType,
        filename: a.filename,
        sizeBytes: a.sizeBytes,
        width: a.width,
        height: a.height,
      });
      attsByMsg.set(a.messageId, arr);
    }

    const counts = await db
      .select({
        parentId: message.parentId,
        c: sql<number>`count(*)::int`,
      })
      .from(message)
      .where(and(inArray(message.parentId, ids), isNull(message.deletedAt)))
      .groupBy(message.parentId);
    for (const row of counts) {
      if (row.parentId) replyCountByParent.set(row.parentId, Number(row.c));
    }

    // Distinct replier userIds per parent, oldest-reply-first, capped at 5.
    const replyRows = await db
      .select({
        parentId: message.parentId,
        userId: message.userId,
        createdAt: message.createdAt,
      })
      .from(message)
      .where(and(inArray(message.parentId, ids), isNull(message.deletedAt)))
      .orderBy(message.createdAt);
    for (const row of replyRows) {
      if (!row.parentId) continue;
      const seen = replyUsersByParent.get(row.parentId) ?? [];
      if (seen.includes(row.userId)) continue;
      if (seen.length >= 5) continue;
      seen.push(row.userId);
      replyUsersByParent.set(row.parentId, seen);
    }
  }

  // Batch-load reactions for these messages so the client can render them
  // inline on load — no N+1 round-trips.
  const reactionsByMsg = new Map<string, MessageRow["reactions"]>();
  if (ids.length > 0) {
    const rxRows = await db
      .select({
        messageId: reaction.messageId,
        emoji: reaction.emoji,
        userId: reaction.userId,
      })
      .from(reaction)
      .where(inArray(reaction.messageId, ids))
      .orderBy(reaction.emoji, reaction.createdAt);
    const perMsg = new Map<string, Map<string, string[]>>();
    for (const r of rxRows) {
      const byEmoji = perMsg.get(r.messageId) ?? new Map<string, string[]>();
      const users = byEmoji.get(r.emoji) ?? [];
      users.push(r.userId);
      byEmoji.set(r.emoji, users);
      perMsg.set(r.messageId, byEmoji);
    }
    for (const [msgId, byEmoji] of perMsg) {
      reactionsByMsg.set(
        msgId,
        Array.from(byEmoji.entries()).map(([emoji, userIds]) => ({
          emoji,
          count: userIds.length,
          userIds,
        })),
      );
    }
  }

  const hydrated: MessageRow[] = rows.map((m) => ({
    id: m.id,
    channelId: m.channelId,
    userId: m.userId,
    parentId: m.parentId,
    content: m.content,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
    attachments: attsByMsg.get(m.id) ?? [],
    replyCount: replyCountByParent.get(m.id) ?? 0,
    replyUserIds: replyUsersByParent.get(m.id) ?? [],
    reactions: reactionsByMsg.get(m.id) ?? [],
  }));
  // Always return oldest → newest, regardless of query direction, so the
  // client can append.
  return params.after ? hydrated : hydrated.reverse();
}

export async function listThreadReplies(
  db: DbLike,
  params: { parentMessageId: string; userId: string; limit?: number },
): Promise<MessageRow[]> {
  const parentRows = await db
    .select({ channelId: message.channelId })
    .from(message)
    .where(eq(message.id, params.parentMessageId))
    .limit(1);
  const parent = parentRows[0];
  if (!parent) throw new ChatError("not_found", "Parent not found");
  const access = await resolveChannelAccess(db, parent.channelId, params.userId);
  if (!access?.canRead) throw new ChatError("forbidden", "Cannot read channel");

  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200);
  const rows = await db
    .select()
    .from(message)
    .where(and(eq(message.parentId, params.parentMessageId), isNull(message.deletedAt)))
    .orderBy(asc(message.createdAt), asc(message.id))
    .limit(limit);

  const ids = rows.map((r) => r.id);
  const attsByMsg = new Map<string, MessageRow["attachments"]>();
  const reactionsByMsg = new Map<string, MessageRow["reactions"]>();
  if (ids.length > 0) {
    const atts = await db.select().from(attachment).where(inArray(attachment.messageId, ids));
    for (const a of atts) {
      const arr = attsByMsg.get(a.messageId) ?? [];
      arr.push({
        id: a.id,
        url: a.url,
        mimeType: a.mimeType,
        filename: a.filename,
        sizeBytes: a.sizeBytes,
        width: a.width,
        height: a.height,
      });
      attsByMsg.set(a.messageId, arr);
    }
    const rxRows = await db
      .select({
        messageId: reaction.messageId,
        emoji: reaction.emoji,
        userId: reaction.userId,
      })
      .from(reaction)
      .where(inArray(reaction.messageId, ids))
      .orderBy(reaction.emoji, reaction.createdAt);
    const perMsg = new Map<string, Map<string, string[]>>();
    for (const r of rxRows) {
      const byEmoji = perMsg.get(r.messageId) ?? new Map<string, string[]>();
      const users = byEmoji.get(r.emoji) ?? [];
      users.push(r.userId);
      byEmoji.set(r.emoji, users);
      perMsg.set(r.messageId, byEmoji);
    }
    for (const [msgId, byEmoji] of perMsg) {
      reactionsByMsg.set(
        msgId,
        Array.from(byEmoji.entries()).map(([emoji, userIds]) => ({
          emoji,
          count: userIds.length,
          userIds,
        })),
      );
    }
  }

  return rows.map((m) => ({
    id: m.id,
    channelId: m.channelId,
    userId: m.userId,
    parentId: m.parentId,
    content: m.content,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    deletedAt: m.deletedAt,
    attachments: attsByMsg.get(m.id) ?? [],
    replyCount: 0,
    replyUserIds: [],
    reactions: reactionsByMsg.get(m.id) ?? [],
  }));
}

export async function editMessage(
  db: DbLike,
  params: { messageId: string; userId: string; content: string },
): Promise<MessageRow> {
  const existing = await getMessageById(db, params.messageId);
  if (!existing) throw new ChatError("not_found", "Message not found");
  if (existing.userId !== params.userId) {
    throw new ChatError("forbidden", "Only the author can edit");
  }
  if (existing.deletedAt) throw new ChatError("bad_request", "Message is deleted");
  const content = params.content.trim();
  if (content.length === 0) throw new ChatError("bad_request", "Empty content");
  if (content.length > 8000) throw new ChatError("bad_request", "Too long");
  await db
    .update(message)
    .set({ content, editedAt: new Date() })
    .where(eq(message.id, params.messageId));
  const updated = await getMessageById(db, params.messageId);
  return updated!;
}

export async function deleteMessage(
  db: DbLike,
  params: { messageId: string; userId: string },
): Promise<void> {
  const existing = await getMessageById(db, params.messageId);
  if (!existing) throw new ChatError("not_found", "Message not found");
  const access = await resolveChannelAccess(db, existing.channelId, params.userId);
  const isAuthor = existing.userId === params.userId;
  const isAdmin = access?.canAdmin ?? false;
  if (!isAuthor && !isAdmin) {
    throw new ChatError("forbidden", "Only the author or a channel admin can delete");
  }
  await db
    .update(message)
    .set({ deletedAt: new Date(), content: "" })
    .where(eq(message.id, params.messageId));
}
