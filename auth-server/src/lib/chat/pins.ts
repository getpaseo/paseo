import { and, asc, eq } from "drizzle-orm";
import { channelMember, message, pin, user as userTable } from "@/db/schema";
import { type DbLike, resolveChannelAccess } from "./authz";
import { ChatError } from "./channels";

export interface PinnedMessage {
  messageId: string;
  channelId: string;
  pinnedBy: string;
  pinnedAt: Date;
  message: {
    id: string;
    userId: string;
    authorName: string;
    content: string;
    createdAt: Date;
  };
}

export async function pinMessage(
  db: DbLike,
  params: { channelId: string; messageId: string; userId: string },
): Promise<void> {
  const msgRows = await db
    .select({
      id: message.id,
      channelId: message.channelId,
      deletedAt: message.deletedAt,
    })
    .from(message)
    .where(eq(message.id, params.messageId))
    .limit(1);
  const msg = msgRows[0];
  if (!msg) throw new ChatError("not_found", "Message not found");
  if (msg.deletedAt) throw new ChatError("bad_request", "Message is deleted");
  if (msg.channelId !== params.channelId) {
    throw new ChatError("bad_request", "Message is not in this channel");
  }

  const access = await resolveChannelAccess(db, params.channelId, params.userId);
  if (!access?.canRead) throw new ChatError("forbidden", "Cannot access channel");

  // Any member can pin; delete (unpin) is more restrictive elsewhere.
  const myMembership = await db
    .select({ c: channelMember.channelId })
    .from(channelMember)
    .where(
      and(
        eq(channelMember.channelId, params.channelId),
        eq(channelMember.userId, params.userId),
      ),
    )
    .limit(1);
  if (myMembership.length === 0 && access.kind !== "public") {
    throw new ChatError("forbidden", "Not a member");
  }

  try {
    await db.insert(pin).values({
      channelId: params.channelId,
      messageId: params.messageId,
      pinnedBy: params.userId,
    });
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      // Already pinned — idempotent.
      return;
    }
    throw err;
  }
}

export async function unpinMessage(
  db: DbLike,
  params: { channelId: string; messageId: string; userId: string },
): Promise<void> {
  const access = await resolveChannelAccess(db, params.channelId, params.userId);
  if (!access?.canRead) throw new ChatError("forbidden", "Cannot access channel");

  // Pinner or admin can unpin.
  const pinRow = await db
    .select({ pinnedBy: pin.pinnedBy })
    .from(pin)
    .where(
      and(
        eq(pin.channelId, params.channelId),
        eq(pin.messageId, params.messageId),
      ),
    )
    .limit(1);
  if (pinRow.length === 0) return;
  const pinner = pinRow[0]!.pinnedBy;
  if (pinner !== params.userId && !access.canAdmin) {
    throw new ChatError("forbidden", "Only the pinner or an admin can unpin");
  }

  await db
    .delete(pin)
    .where(
      and(
        eq(pin.channelId, params.channelId),
        eq(pin.messageId, params.messageId),
      ),
    );
}

export async function listPinnedMessages(
  db: DbLike,
  params: { channelId: string; userId: string },
): Promise<PinnedMessage[]> {
  const access = await resolveChannelAccess(db, params.channelId, params.userId);
  if (!access?.canRead) throw new ChatError("forbidden", "Cannot access channel");

  const rows = await db
    .select({
      messageId: pin.messageId,
      channelId: pin.channelId,
      pinnedBy: pin.pinnedBy,
      pinnedAt: pin.pinnedAt,
      msgId: message.id,
      msgUserId: message.userId,
      msgContent: message.content,
      msgCreatedAt: message.createdAt,
      msgDeletedAt: message.deletedAt,
      authorName: userTable.name,
    })
    .from(pin)
    .innerJoin(message, eq(message.id, pin.messageId))
    .innerJoin(userTable, eq(userTable.id, message.userId))
    .where(eq(pin.channelId, params.channelId))
    .orderBy(asc(pin.pinnedAt));

  return rows
    .filter((r) => r.msgDeletedAt === null)
    .map((r) => ({
      messageId: r.messageId,
      channelId: r.channelId,
      pinnedBy: r.pinnedBy,
      pinnedAt: r.pinnedAt,
      message: {
        id: r.msgId,
        userId: r.msgUserId,
        authorName: r.authorName,
        content: r.msgContent,
        createdAt: r.msgCreatedAt,
      },
    }));
}
