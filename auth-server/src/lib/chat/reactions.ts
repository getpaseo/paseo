import { and, eq, sql } from "drizzle-orm";
import { message, reaction } from "@/db/schema";
import { ChatError } from "./channels";
import { type DbLike, resolveChannelAccess } from "./authz";

export interface ReactionGroup {
  emoji: string;
  count: number;
  userIds: string[];
}

// Allow any reasonable emoji or shortcode. We don't parse — just guard
// against obvious abuse (length + no control chars).
function assertValidEmoji(emoji: string) {
  if (emoji.length === 0 || emoji.length > 64) {
    throw new ChatError("bad_request", "Invalid emoji");
  }
  if (/[\u0000-\u001f\u007f]/.test(emoji)) {
    throw new ChatError("bad_request", "Invalid emoji");
  }
}

export async function addReaction(
  db: DbLike,
  params: { messageId: string; userId: string; emoji: string },
): Promise<void> {
  assertValidEmoji(params.emoji);
  const msgRows = await db
    .select({ channelId: message.channelId, deletedAt: message.deletedAt })
    .from(message)
    .where(eq(message.id, params.messageId))
    .limit(1);
  const msg = msgRows[0];
  if (!msg) throw new ChatError("not_found", "Message not found");
  if (msg.deletedAt) throw new ChatError("bad_request", "Message is deleted");

  const access = await resolveChannelAccess(db, msg.channelId, params.userId);
  if (!access?.canRead) throw new ChatError("forbidden", "Cannot react in channel");

  try {
    await db.insert(reaction).values({
      messageId: params.messageId,
      userId: params.userId,
      emoji: params.emoji,
    });
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      // Already reacted — idempotent.
      return;
    }
    throw err;
  }
}

export async function removeReaction(
  db: DbLike,
  params: { messageId: string; userId: string; emoji: string },
): Promise<void> {
  assertValidEmoji(params.emoji);
  await db
    .delete(reaction)
    .where(
      and(
        eq(reaction.messageId, params.messageId),
        eq(reaction.userId, params.userId),
        eq(reaction.emoji, params.emoji),
      ),
    );
}

export async function listReactions(
  db: DbLike,
  messageId: string,
): Promise<ReactionGroup[]> {
  const rows = await db
    .select({
      emoji: reaction.emoji,
      userId: reaction.userId,
    })
    .from(reaction)
    .where(eq(reaction.messageId, messageId))
    .orderBy(reaction.emoji, reaction.createdAt);

  const grouped = new Map<string, string[]>();
  for (const r of rows) {
    const arr = grouped.get(r.emoji) ?? [];
    arr.push(r.userId);
    grouped.set(r.emoji, arr);
  }
  return Array.from(grouped.entries()).map(([emoji, userIds]) => ({
    emoji,
    count: userIds.length,
    userIds,
  }));
}

export async function countReactions(
  db: DbLike,
  messageId: string,
): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reaction)
    .where(eq(reaction.messageId, messageId));
  return count;
}
