import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { channel, channelMember, mention, message, user as userTable } from "@/db/schema";
import { ChatError } from "./channels";
import { type DbLike, isOrgMember } from "./authz";

export interface SearchHit {
  messageId: string;
  channelId: string;
  channelName: string | null;
  channelKind: "public" | "private" | "dm";
  userId: string;
  authorName: string;
  content: string;
  createdAt: Date;
}

export async function searchMessages(
  db: DbLike,
  params: {
    orgId: string;
    userId: string;
    query: string;
    channelId?: string;
    limit?: number;
  },
): Promise<SearchHit[]> {
  if (!(await isOrgMember(db, params.orgId, params.userId))) {
    throw new ChatError("not_org_member", "User is not in the org");
  }
  const q = params.query.trim();
  if (q.length < 2) return [];
  const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);

  // Visible channels = public in the org + private/dm where caller is a member.
  const myMemberships = await db
    .select({ channelId: channelMember.channelId })
    .from(channelMember)
    .where(eq(channelMember.userId, params.userId));
  const myChannelIds = myMemberships.map((m) => m.channelId);

  const visibility = or(
    eq(channel.kind, "public"),
    myChannelIds.length > 0 ? inArray(channel.id, myChannelIds) : sql`false`,
  );

  // Full-text search: use `simple` so we don't depend on language config,
  // and fall back to ILIKE for short tokens / punctuation-only queries where
  // tsvector would over-aggressively discard terms. `websearch_to_tsquery`
  // handles user-friendly syntax (quotes, OR, minus).
  const tsqRaw = sql`websearch_to_tsquery('simple', ${q})`;
  const tsvExpr = sql`to_tsvector('simple', ${message.content})`;
  const ftsMatch = sql`${tsvExpr} @@ ${tsqRaw}`;
  const ilikeMatch = sql`${message.content} ILIKE ${"%" + q.replace(/[%_]/g, "") + "%"}`;

  const conditions = [
    eq(channel.orgId, params.orgId),
    visibility,
    isNull(message.deletedAt),
    or(ftsMatch, ilikeMatch),
  ];
  if (params.channelId) conditions.push(eq(message.channelId, params.channelId));

  const rows = await db
    .select({
      messageId: message.id,
      channelId: message.channelId,
      userId: message.userId,
      content: message.content,
      createdAt: message.createdAt,
      channelName: channel.name,
      channelKind: channel.kind,
      authorName: userTable.name,
      rank: sql<number>`coalesce(ts_rank(${tsvExpr}, ${tsqRaw}), 0)`,
    })
    .from(message)
    .innerJoin(channel, eq(channel.id, message.channelId))
    .innerJoin(userTable, eq(userTable.id, message.userId))
    .where(and(...conditions))
    .orderBy(desc(sql`coalesce(ts_rank(${tsvExpr}, ${tsqRaw}), 0)`), desc(message.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    messageId: r.messageId,
    channelId: r.channelId,
    channelName: r.channelName,
    channelKind: r.channelKind as "public" | "private" | "dm",
    userId: r.userId,
    authorName: r.authorName,
    content: r.content,
    createdAt: r.createdAt,
  }));
}

export async function listMyMentions(
  db: DbLike,
  params: { orgId: string; userId: string; limit?: number },
): Promise<SearchHit[]> {
  if (!(await isOrgMember(db, params.orgId, params.userId))) {
    throw new ChatError("not_org_member", "User is not in the org");
  }
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);

  const rows = await db
    .select({
      messageId: message.id,
      channelId: message.channelId,
      userId: message.userId,
      content: message.content,
      createdAt: message.createdAt,
      channelName: channel.name,
      channelKind: channel.kind,
      authorName: userTable.name,
      channelOrgId: channel.orgId,
    })
    .from(mention)
    .innerJoin(message, eq(message.id, mention.messageId))
    .innerJoin(channel, eq(channel.id, message.channelId))
    .innerJoin(userTable, eq(userTable.id, message.userId))
    .where(
      and(
        eq(mention.userId, params.userId),
        eq(channel.orgId, params.orgId),
        isNull(message.deletedAt),
      ),
    )
    .orderBy(desc(message.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    messageId: r.messageId,
    channelId: r.channelId,
    channelName: r.channelName,
    channelKind: r.channelKind as "public" | "private" | "dm",
    userId: r.userId,
    authorName: r.authorName,
    content: r.content,
    createdAt: r.createdAt,
  }));
}
