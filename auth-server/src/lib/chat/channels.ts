import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { channel, channelMember, member, mention, message, user as userTable } from "@/db/schema";
import { type DbLike, isOrgMember } from "./authz";
import { newChannelId, slugifyChannelName } from "./ids";

export class ChatError extends Error {
  constructor(
    public code: "not_found" | "forbidden" | "conflict" | "bad_request" | "not_org_member",
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

export interface CreateChannelInput {
  orgId: string;
  userId: string;
  name: string;
  kind: "public" | "private";
  topic?: string | null;
}

export type NotifyPref = "all" | "mentions" | "nothing";

export interface ChannelSummary {
  id: string;
  orgId: string;
  name: string | null;
  topic: string | null;
  kind: "public" | "private" | "dm";
  createdBy: string;
  createdAt: Date;
  archivedAt: Date | null;
  memberCount: number;
  isMember: boolean;
  unreadCount: number;
  hasMention: boolean;
  lastReadAt: Date | null;
  muted: boolean;
  notifyPref: NotifyPref;
  /**
   * For DM channels, the other participants' user ids (excludes the viewer).
   * Empty/omitted for non-DM channels. Lets the client render DMs alongside
   * org members without resorting to name-matching heuristics.
   */
  dmPeerUserIds?: string[];
}

export async function createChannel(
  db: DbLike,
  input: CreateChannelInput,
): Promise<ChannelSummary> {
  if (!(await isOrgMember(db, input.orgId, input.userId))) {
    throw new ChatError("not_org_member", "User is not a member of this org");
  }
  const slug = slugifyChannelName(input.name);
  if (!slug) throw new ChatError("bad_request", "Invalid channel name");

  const id = newChannelId();
  try {
    await db.insert(channel).values({
      id,
      orgId: input.orgId,
      name: slug,
      topic: input.topic ?? null,
      kind: input.kind,
      createdBy: input.userId,
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new ChatError("conflict", "A channel with that name already exists");
    }
    throw err;
  }
  await db.insert(channelMember).values({
    channelId: id,
    userId: input.userId,
    role: "admin",
  });
  return (await getChannelById(db, id, input.userId))!;
}

export async function getChannelById(
  db: DbLike,
  channelId: string,
  viewerId: string,
): Promise<ChannelSummary | null> {
  const rows = await db.select().from(channel).where(eq(channel.id, channelId)).limit(1);
  const c = rows[0];
  if (!c) return null;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(channelMember)
    .where(eq(channelMember.channelId, channelId));

  const mine = await db
    .select({
      channelId: channelMember.channelId,
      lastReadAt: channelMember.lastReadAt,
      muted: channelMember.muted,
      notifyPref: channelMember.notifyPref,
    })
    .from(channelMember)
    .where(and(eq(channelMember.channelId, channelId), eq(channelMember.userId, viewerId)))
    .limit(1);
  const lastReadAt = mine[0]?.lastReadAt ?? null;
  const muted = mine[0]?.muted ?? false;
  const notifyPref = (mine[0]?.notifyPref as NotifyPref | undefined) ?? "all";

  const unread = await computeUnread(db, viewerId, [channelId]);
  const u = unread.get(channelId);
  const rawUnreadCount = u?.unreadCount ?? 0;
  const rawHasMention = u?.hasMention ?? false;
  const { unreadCount: effectiveUnreadCount, hasMention: effectiveHasMention } = applyNotifyPref(
    rawUnreadCount,
    rawHasMention,
    notifyPref,
  );

  let dmPeerUserIds: string[] | undefined;
  if (c.kind === "dm") {
    const peers = await db
      .select({ userId: channelMember.userId })
      .from(channelMember)
      .where(eq(channelMember.channelId, channelId));
    dmPeerUserIds = peers.map((p) => p.userId).filter((uid) => uid !== viewerId);
  }

  return {
    id: c.id,
    orgId: c.orgId,
    name: c.name,
    topic: c.topic,
    kind: c.kind as "public" | "private" | "dm",
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    archivedAt: c.archivedAt,
    memberCount: count,
    isMember: mine.length > 0,
    unreadCount: effectiveUnreadCount,
    hasMention: effectiveHasMention,
    lastReadAt,
    muted,
    notifyPref,
    ...(dmPeerUserIds ? { dmPeerUserIds } : {}),
  };
}

/**
 * Batch-compute unread + hasMention per channel for a given viewer.
 * For each channel the viewer is in, counts messages newer than their
 * `last_read_at`, not authored by themselves, not soft-deleted.
 * Channels the viewer hasn't joined get { unreadCount: 0, hasMention: false }.
 */
export async function computeUnread(
  db: DbLike,
  userId: string,
  channelIds: string[],
): Promise<Map<string, { unreadCount: number; hasMention: boolean }>> {
  const out = new Map<string, { unreadCount: number; hasMention: boolean }>();
  if (channelIds.length === 0) return out;

  const rows = await db
    .select({
      channelId: message.channelId,
      unreadCount: sql<number>`count(*)::int`,
      hasMention: sql<boolean>`bool_or(exists (
        select 1 from ${mention}
        where ${mention.messageId} = ${message.id}
          and ${mention.userId} = ${userId}
      ))`,
    })
    .from(message)
    .innerJoin(
      channelMember,
      and(eq(channelMember.channelId, message.channelId), eq(channelMember.userId, userId)),
    )
    .where(
      and(
        inArray(message.channelId, channelIds),
        isNull(message.deletedAt),
        ne(message.userId, userId),
        or(isNull(channelMember.lastReadAt), gt(message.createdAt, channelMember.lastReadAt)),
      ),
    )
    .groupBy(message.channelId);

  for (const r of rows) {
    out.set(r.channelId, {
      unreadCount: Number(r.unreadCount ?? 0),
      hasMention: !!r.hasMention,
    });
  }
  return out;
}

export async function markChannelRead(
  db: DbLike,
  params: { channelId: string; userId: string; at?: Date },
): Promise<void> {
  const when = params.at ?? new Date();
  // Only a member can "read" a channel — this is idempotent if they've never
  // set it before (upsert via update; bail if not a member).
  await db
    .update(channelMember)
    .set({ lastReadAt: when })
    .where(
      and(eq(channelMember.channelId, params.channelId), eq(channelMember.userId, params.userId)),
    );
}

export async function listChannelsForUser(
  db: DbLike,
  orgId: string,
  userId: string,
): Promise<ChannelSummary[]> {
  if (!(await isOrgMember(db, orgId, userId))) {
    throw new ChatError("not_org_member", "User is not a member of this org");
  }

  // First-visit bootstrap: make sure the org has at least one public channel.
  // Cheap when #general already exists (a single SELECT on the indexed path).
  await ensureGeneralChannel(db, orgId);

  const myMembershipRows = await db
    .select({ channelId: channelMember.channelId })
    .from(channelMember)
    .where(eq(channelMember.userId, userId));
  const myChannelIds = myMembershipRows.map((r) => r.channelId);

  const whereClause = and(
    eq(channel.orgId, orgId),
    or(
      eq(channel.kind, "public"),
      myChannelIds.length > 0 ? inArray(channel.id, myChannelIds) : sql`false`,
    ),
  );

  const rows = await db
    .select()
    .from(channel)
    .where(whereClause)
    .orderBy(asc(channel.kind), asc(channel.name));

  // Exclude DMs from the main channel list — those ship via /dms.
  const channelRows = rows.filter((r) => r.kind !== "dm");

  const counts = new Map<string, number>();
  if (channelRows.length > 0) {
    const grouped = await db
      .select({
        channelId: channelMember.channelId,
        count: sql<number>`count(*)::int`,
      })
      .from(channelMember)
      .where(
        inArray(
          channelMember.channelId,
          channelRows.map((r) => r.id),
        ),
      )
      .groupBy(channelMember.channelId);
    for (const g of grouped) counts.set(g.channelId, g.count);
  }

  const myIdsSet = new Set(myChannelIds);
  const myPrefs = new Map<
    string,
    { lastReadAt: Date | null; muted: boolean; notifyPref: NotifyPref }
  >();
  if (myChannelIds.length > 0) {
    const rows = await db
      .select({
        channelId: channelMember.channelId,
        lastReadAt: channelMember.lastReadAt,
        muted: channelMember.muted,
        notifyPref: channelMember.notifyPref,
      })
      .from(channelMember)
      .where(and(eq(channelMember.userId, userId), inArray(channelMember.channelId, myChannelIds)));
    for (const r of rows) {
      myPrefs.set(r.channelId, {
        lastReadAt: r.lastReadAt,
        muted: r.muted,
        notifyPref: (r.notifyPref as NotifyPref) ?? "all",
      });
    }
  }
  const unread = await computeUnread(db, userId, myChannelIds);

  return channelRows.map((c) => {
    const u = unread.get(c.id);
    const p = myPrefs.get(c.id);
    const notifyPref: NotifyPref = p?.notifyPref ?? "all";
    const { unreadCount, hasMention } = applyNotifyPref(
      u?.unreadCount ?? 0,
      u?.hasMention ?? false,
      notifyPref,
    );
    return {
      id: c.id,
      orgId: c.orgId,
      name: c.name,
      topic: c.topic,
      kind: c.kind as "public" | "private" | "dm",
      createdBy: c.createdBy,
      createdAt: c.createdAt,
      archivedAt: c.archivedAt,
      memberCount: counts.get(c.id) ?? 0,
      isMember: myIdsSet.has(c.id),
      unreadCount,
      hasMention,
      lastReadAt: p?.lastReadAt ?? null,
      muted: p?.muted ?? false,
      notifyPref,
    };
  });
}

/**
 * Reshape raw unread counts according to the viewer's per-channel
 * `notifyPref`. `computeUnread` stays pure; this is the presentation rule:
 *   - "nothing": no badge, no mention indicator
 *   - "mentions": unread count collapses to a single-bit "mentioned or not"
 *   - "all": pass through
 */
function applyNotifyPref(
  unreadCount: number,
  hasMention: boolean,
  notifyPref: NotifyPref,
): { unreadCount: number; hasMention: boolean } {
  if (notifyPref === "nothing") {
    return { unreadCount: 0, hasMention: false };
  }
  if (notifyPref === "mentions") {
    return { unreadCount: hasMention ? 1 : 0, hasMention };
  }
  return { unreadCount, hasMention };
}

/**
 * Ensure the org has a default `#general` channel. Idempotent: returns the
 * existing channel id if any public channel already exists, otherwise creates
 * `#general` owned by the org's owner. Safe to call on every channel list
 * request — the `channel_org_name_unique` partial index guards against races.
 */
export async function ensureGeneralChannel(db: DbLike, orgId: string): Promise<string | null> {
  const existing = await db
    .select({ id: channel.id })
    .from(channel)
    .where(and(eq(channel.orgId, orgId), eq(channel.kind, "public")))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const owner = await db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.role, "owner")))
    .limit(1);
  const creatorId = owner[0]?.userId;
  if (!creatorId) return null;

  const id = newChannelId();
  try {
    await db.insert(channel).values({
      id,
      orgId,
      name: "general",
      topic: "Team-wide announcements and discussion.",
      kind: "public",
      createdBy: creatorId,
    });
    await db.insert(channelMember).values({
      channelId: id,
      userId: creatorId,
      role: "admin",
    });
    return id;
  } catch (err) {
    // Race: another request created it first. Re-read and return whatever won.
    const retry = await db
      .select({ id: channel.id })
      .from(channel)
      .where(and(eq(channel.orgId, orgId), eq(channel.kind, "public")))
      .limit(1);
    return retry[0]?.id ?? null;
  }
}

export async function updateChannelPrefs(
  db: DbLike,
  params: {
    channelId: string;
    userId: string;
    pref?: NotifyPref;
    muted?: boolean;
  },
): Promise<void> {
  const patch: { notifyPref?: NotifyPref; muted?: boolean } = {};
  if (params.pref) patch.notifyPref = params.pref;
  if (typeof params.muted === "boolean") patch.muted = params.muted;
  if (Object.keys(patch).length === 0) return;
  await db
    .update(channelMember)
    .set(patch)
    .where(
      and(eq(channelMember.channelId, params.channelId), eq(channelMember.userId, params.userId)),
    );
}

export async function addChannelMember(
  db: DbLike,
  params: { channelId: string; userId: string; addedBy: string; role?: "admin" | "member" },
): Promise<void> {
  const chan = await requireChannel(db, params.channelId);
  if (chan.kind === "dm") {
    throw new ChatError("forbidden", "DMs have a fixed membership");
  }
  if (!(await isOrgMember(db, chan.orgId, params.addedBy))) {
    throw new ChatError("forbidden", "Inviter is not in the org");
  }
  if (!(await isOrgMember(db, chan.orgId, params.userId))) {
    throw new ChatError("forbidden", "User is not in the org");
  }
  // For private channels the inviter must be a member.
  if (chan.kind === "private") {
    const inviterInChannel = await db
      .select({ c: channelMember.channelId })
      .from(channelMember)
      .where(
        and(
          eq(channelMember.channelId, params.channelId),
          eq(channelMember.userId, params.addedBy),
        ),
      )
      .limit(1);
    if (inviterInChannel.length === 0) {
      throw new ChatError("forbidden", "Inviter is not in the channel");
    }
  }
  try {
    await db.insert(channelMember).values({
      channelId: params.channelId,
      userId: params.userId,
      role: params.role ?? "member",
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      // Idempotent: already a member.
      return;
    }
    throw err;
  }
}

export async function removeChannelMember(
  db: DbLike,
  params: { channelId: string; userId: string; removedBy: string },
): Promise<void> {
  const chan = await requireChannel(db, params.channelId);
  if (chan.kind === "dm") {
    throw new ChatError("forbidden", "DMs have a fixed membership");
  }
  // A user can always leave themselves; otherwise requires admin.
  if (params.userId !== params.removedBy) {
    const actorRow = await db
      .select({ role: channelMember.role })
      .from(channelMember)
      .where(
        and(
          eq(channelMember.channelId, params.channelId),
          eq(channelMember.userId, params.removedBy),
        ),
      )
      .limit(1);
    if (actorRow[0]?.role !== "admin") {
      throw new ChatError("forbidden", "Only channel admins can remove others");
    }
  }
  await db
    .delete(channelMember)
    .where(
      and(eq(channelMember.channelId, params.channelId), eq(channelMember.userId, params.userId)),
    );
}

export async function archiveChannel(
  db: DbLike,
  params: { channelId: string; userId: string },
): Promise<void> {
  const chan = await requireChannel(db, params.channelId);
  const actorRow = await db
    .select({ role: channelMember.role })
    .from(channelMember)
    .where(and(eq(channelMember.channelId, chan.id), eq(channelMember.userId, params.userId)))
    .limit(1);
  if (actorRow[0]?.role !== "admin") {
    throw new ChatError("forbidden", "Only channel admins can archive");
  }
  await db.update(channel).set({ archivedAt: new Date() }).where(eq(channel.id, chan.id));
}

/**
 * Permanently delete a channel and all of its messages, members, pins, and
 * reactions. Gated to channel admins only — the row is nuked via cascade on
 * the FK references declared in `channel`.
 */
export async function deleteChannel(
  db: DbLike,
  params: { channelId: string; userId: string },
): Promise<void> {
  const chan = await requireChannel(db, params.channelId);
  if (chan.kind === "dm") {
    throw new ChatError("forbidden", "DMs cannot be deleted");
  }
  const actorRow = await db
    .select({ role: channelMember.role })
    .from(channelMember)
    .where(and(eq(channelMember.channelId, chan.id), eq(channelMember.userId, params.userId)))
    .limit(1);
  if (actorRow[0]?.role !== "admin") {
    throw new ChatError("forbidden", "Only channel admins can delete");
  }
  await db.delete(channel).where(eq(channel.id, chan.id));
}

export async function listChannelMembers(db: DbLike, channelId: string, viewerId: string) {
  const chan = await requireChannel(db, channelId);
  if (chan.kind !== "public") {
    const mine = await db
      .select({ c: channelMember.channelId })
      .from(channelMember)
      .where(and(eq(channelMember.channelId, channelId), eq(channelMember.userId, viewerId)))
      .limit(1);
    if (mine.length === 0) {
      throw new ChatError("forbidden", "Not a member");
    }
  } else if (!(await isOrgMember(db, chan.orgId, viewerId))) {
    throw new ChatError("forbidden", "Not in org");
  }
  return db
    .select({
      userId: channelMember.userId,
      role: channelMember.role,
      joinedAt: channelMember.joinedAt,
      name: userTable.name,
      email: userTable.email,
      image: userTable.image,
    })
    .from(channelMember)
    .innerJoin(userTable, eq(userTable.id, channelMember.userId))
    .where(eq(channelMember.channelId, channelId))
    .orderBy(desc(channelMember.role), asc(channelMember.joinedAt));
}

/**
 * Create or reuse a DM between the given participants (including caller).
 * Participants must all be in the same org as the caller. Idempotent for the
 * same sorted set of userIds.
 */
export async function openDm(
  db: DbLike,
  params: { orgId: string; userId: string; otherUserIds: string[] },
): Promise<ChannelSummary> {
  if (params.otherUserIds.length === 0) {
    throw new ChatError("bad_request", "At least one other user is required");
  }
  const members = Array.from(new Set([params.userId, ...params.otherUserIds])).sort();
  if (members.length < 2) {
    throw new ChatError("bad_request", "A DM requires at least 2 distinct users");
  }
  for (const uid of members) {
    if (!(await isOrgMember(db, params.orgId, uid))) {
      throw new ChatError("forbidden", `User ${uid} is not in this org`);
    }
  }

  // Find an existing DM in this org with exactly these members.
  const existing = await db.execute(sql`
    SELECT c.id
    FROM channel c
    WHERE c.org_id = ${params.orgId}
      AND c.kind = 'dm'
      AND (
        SELECT array_agg(cm.user_id ORDER BY cm.user_id)
        FROM channel_member cm
        WHERE cm.channel_id = c.id
      ) = ${sql`ARRAY[${sql.join(
        members.map((m) => sql`${m}`),
        sql`, `,
      )}]::text[]`}
    LIMIT 1
  `);
  const existingId = (existing.rows[0] as { id?: string } | undefined)?.id;
  if (existingId) {
    return (await getChannelById(db, existingId, params.userId))!;
  }

  const id = newChannelId();
  await db.insert(channel).values({
    id,
    orgId: params.orgId,
    name: null,
    kind: "dm",
    createdBy: params.userId,
  });
  await db.insert(channelMember).values(
    members.map((uid) => ({
      channelId: id,
      userId: uid,
      role: "member" as const,
    })),
  );
  return (await getChannelById(db, id, params.userId))!;
}

export async function listDmsForUser(
  db: DbLike,
  params: { userId: string; orgId?: string },
): Promise<ChannelSummary[]> {
  const myDmRows = await db
    .select({ channelId: channelMember.channelId })
    .from(channelMember)
    .innerJoin(channel, eq(channel.id, channelMember.channelId))
    .where(
      and(
        eq(channelMember.userId, params.userId),
        eq(channel.kind, "dm"),
        params.orgId ? eq(channel.orgId, params.orgId) : isNotNull(channel.orgId),
      ),
    );
  const ids = myDmRows.map((r) => r.channelId);
  if (ids.length === 0) return [];

  const rows = await db.select().from(channel).where(inArray(channel.id, ids));
  return Promise.all(rows.map(async (c) => (await getChannelById(db, c.id, params.userId))!));
}

async function requireChannel(
  db: DbLike,
  channelId: string,
): Promise<{ id: string; orgId: string; kind: "public" | "private" | "dm" }> {
  const rows = await db
    .select({ id: channel.id, orgId: channel.orgId, kind: channel.kind })
    .from(channel)
    .where(eq(channel.id, channelId))
    .limit(1);
  const c = rows[0];
  if (!c) throw new ChatError("not_found", "Channel not found");
  return { id: c.id, orgId: c.orgId, kind: c.kind as "public" | "private" | "dm" };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}
