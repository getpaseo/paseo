import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { channel, channelMember, member } from "@/db/schema";
import * as schema from "@/db/schema";

export type DbLike = NodePgDatabase<typeof schema>;

export async function isOrgMember(
  db: DbLike,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

export async function getOrgRole(
  db: DbLike,
  orgId: string,
  userId: string,
): Promise<"owner" | "admin" | "member" | null> {
  const rows = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  const role = rows[0]?.role;
  if (role === "owner" || role === "admin" || role === "member") return role;
  return null;
}

export async function isChannelMember(
  db: DbLike,
  channelId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ channelId: channelMember.channelId })
    .from(channelMember)
    .where(
      and(eq(channelMember.channelId, channelId), eq(channelMember.userId, userId)),
    )
    .limit(1);
  return rows.length > 0;
}

export type ChannelAccess = {
  canRead: boolean;
  canWrite: boolean;
  canAdmin: boolean;
  orgId: string;
  kind: "public" | "private" | "dm";
  archived: boolean;
};

/**
 * Single lookup that tells whether a user can read/write/admin the channel,
 * based on org membership + channel membership + channel kind/role.
 *
 * Returns null when the user isn't even in the org — caller should 403/404.
 */
export async function resolveChannelAccess(
  db: DbLike,
  channelId: string,
  userId: string,
): Promise<ChannelAccess | null> {
  const chanRows = await db
    .select({
      orgId: channel.orgId,
      kind: channel.kind,
      archivedAt: channel.archivedAt,
    })
    .from(channel)
    .where(eq(channel.id, channelId))
    .limit(1);
  const chan = chanRows[0];
  if (!chan) return null;

  const orgRole = await getOrgRole(db, chan.orgId, userId);
  if (!orgRole) return null;

  const memberRows = await db
    .select({ role: channelMember.role })
    .from(channelMember)
    .where(
      and(eq(channelMember.channelId, channelId), eq(channelMember.userId, userId)),
    )
    .limit(1);
  const isMember = memberRows.length > 0;
  const chanRole = memberRows[0]?.role;

  const kind = chan.kind as "public" | "private" | "dm";
  const archived = chan.archivedAt !== null;

  // Slack-ish: public channels are writable by any org member without
  // needing to "join" first. Private channels and DMs require explicit
  // membership for both read and write.
  const canRead = kind === "public" ? true : isMember;
  const canWrite = !archived && (kind === "public" ? true : isMember);
  const canAdmin =
    orgRole === "owner" ||
    orgRole === "admin" ||
    chanRole === "admin";

  return { canRead, canWrite, canAdmin, orgId: chan.orgId, kind, archived };
}
