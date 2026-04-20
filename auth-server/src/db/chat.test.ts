import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, or } from "drizzle-orm";
import { channel, channelMember, mention, message, reaction } from "@/db/schema";
import { setupTestDb, resetDb, teardownTestDb, type TestDb } from "@/test/db";
import { addOrgMember, createTestChannel, createTestOrg, createTestUser } from "@/test/fixtures";

let db: TestDb;

beforeAll(async () => {
  db = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await resetDb(db);
});

describe("channel schema", () => {
  it("accepts public channel creation", async () => {
    const owner = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    const chan = await createTestChannel(db, {
      orgId: org.id,
      createdBy: owner.id,
      name: "general",
      kind: "public",
    });
    const rows = await db.select().from(channel).where(eq(channel.id, chan.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("general");
    expect(rows[0]?.kind).toBe("public");
  });

  it("rejects duplicate channel name within same org", async () => {
    const owner = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await createTestChannel(db, { orgId: org.id, createdBy: owner.id, name: "dup" });
    await expect(
      createTestChannel(db, { orgId: org.id, createdBy: owner.id, name: "dup" }),
    ).rejects.toThrow(/channel_org_name_unique|duplicate key/);
  });

  it("allows same channel name across different orgs", async () => {
    const owner = await createTestUser(db);
    const orgA = await createTestOrg(db, owner.id);
    const orgB = await createTestOrg(db, owner.id);
    await createTestChannel(db, { orgId: orgA.id, createdBy: owner.id, name: "general" });
    await expect(
      createTestChannel(db, { orgId: orgB.id, createdBy: owner.id, name: "general" }),
    ).resolves.toBeDefined();
  });

  it("allows multiple DMs with null name in the same org", async () => {
    const owner = await createTestUser(db);
    const other = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await createTestChannel(db, { orgId: org.id, createdBy: owner.id, name: null, kind: "dm" });
    await expect(
      createTestChannel(db, { orgId: org.id, createdBy: other.id, name: null, kind: "dm" }),
    ).resolves.toBeDefined();
  });
});

describe("channel_member schema", () => {
  it("deduplicates (channel_id, user_id) via composite PK", async () => {
    const owner = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    const chan = await createTestChannel(db, { orgId: org.id, createdBy: owner.id });
    await expect(
      db.insert(channelMember).values({
        channelId: chan.id,
        userId: owner.id,
      }),
    ).rejects.toThrow(/duplicate key|channel_member_pkey/);
  });

  it("cascades member removal when channel is deleted", async () => {
    const owner = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    const chan = await createTestChannel(db, { orgId: org.id, createdBy: owner.id });
    await db.delete(channel).where(eq(channel.id, chan.id));
    const remaining = await db
      .select()
      .from(channelMember)
      .where(eq(channelMember.channelId, chan.id));
    expect(remaining).toHaveLength(0);
  });
});

describe("message schema", () => {
  it("stores message ordered by created_at", async () => {
    const owner = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    const chan = await createTestChannel(db, { orgId: org.id, createdBy: owner.id });
    const ids = [`msg_${randomUUID()}`, `msg_${randomUUID()}`, `msg_${randomUUID()}`];
    for (let i = 0; i < ids.length; i++) {
      await db.insert(message).values({
        id: ids[i]!,
        channelId: chan.id,
        userId: owner.id,
        content: `msg ${i}`,
      });
    }
    const rows = await db
      .select({ id: message.id })
      .from(message)
      .where(eq(message.channelId, chan.id))
      .orderBy(message.createdAt, message.id);
    expect(rows.map((r) => r.id)).toEqual(ids);
  });

  it("supports threads via parent_id self-FK", async () => {
    const owner = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    const chan = await createTestChannel(db, { orgId: org.id, createdBy: owner.id });
    const parentId = `msg_${randomUUID()}`;
    await db.insert(message).values({
      id: parentId,
      channelId: chan.id,
      userId: owner.id,
      content: "parent",
    });
    const replyId = `msg_${randomUUID()}`;
    await db.insert(message).values({
      id: replyId,
      channelId: chan.id,
      userId: owner.id,
      parentId,
      content: "reply",
    });
    const replies = await db.select().from(message).where(eq(message.parentId, parentId));
    expect(replies).toHaveLength(1);
    expect(replies[0]?.id).toBe(replyId);
  });

  it("rejects parent_id that does not point at a real message", async () => {
    const owner = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    const chan = await createTestChannel(db, { orgId: org.id, createdBy: owner.id });
    await expect(
      db.insert(message).values({
        id: `msg_${randomUUID()}`,
        channelId: chan.id,
        userId: owner.id,
        parentId: "does-not-exist",
        content: "orphan",
      }),
    ).rejects.toThrow(/message_parent_fkey|foreign key/);
  });
});

describe("reaction & mention schema", () => {
  it("reaction PK blocks duplicate (message, user, emoji)", async () => {
    const owner = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    const chan = await createTestChannel(db, { orgId: org.id, createdBy: owner.id });
    const msgId = `msg_${randomUUID()}`;
    await db.insert(message).values({
      id: msgId,
      channelId: chan.id,
      userId: owner.id,
      content: "hi",
    });
    await db.insert(reaction).values({ messageId: msgId, userId: owner.id, emoji: "👍" });
    await expect(
      db.insert(reaction).values({ messageId: msgId, userId: owner.id, emoji: "👍" }),
    ).rejects.toThrow(/duplicate key|reaction_pkey/);
    // Different emoji by same user = allowed
    await expect(
      db.insert(reaction).values({ messageId: msgId, userId: owner.id, emoji: "🎉" }),
    ).resolves.toBeDefined();
  });

  it("mention PK blocks duplicate (message, user)", async () => {
    const owner = await createTestUser(db);
    const other = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    const chan = await createTestChannel(db, { orgId: org.id, createdBy: owner.id });
    const msgId = `msg_${randomUUID()}`;
    await db.insert(message).values({
      id: msgId,
      channelId: chan.id,
      userId: owner.id,
      content: `hey <@${other.id}>`,
    });
    await db.insert(mention).values({ messageId: msgId, userId: other.id });
    await expect(db.insert(mention).values({ messageId: msgId, userId: other.id })).rejects.toThrow(
      /duplicate key|mention_pkey/,
    );
  });
});

describe("channel visibility query", () => {
  /**
   * Replicates the query we'll use in GET /orgs/:orgId/channels:
   *   public channels of the org
   *   + private/dm channels where the user is a member
   */
  async function visibleChannelIds(db: TestDb, orgId: string, userId: string) {
    const myMemberships = await db
      .select({ channelId: channelMember.channelId })
      .from(channelMember)
      .where(eq(channelMember.userId, userId));
    const memberIds = myMemberships.map((m) => m.channelId);
    const rows = await db
      .select({ id: channel.id })
      .from(channel)
      .where(
        and(
          eq(channel.orgId, orgId),
          or(
            eq(channel.kind, "public"),
            memberIds.length > 0 ? inArray(channel.id, memberIds) : undefined,
          ),
        ),
      );
    return rows.map((r) => r.id).sort();
  }

  it("returns public channels to everyone in the org, but not privates they don't belong to", async () => {
    const owner = await createTestUser(db);
    const bystander = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await addOrgMember(db, org.id, bystander.id);

    const pub = await createTestChannel(db, {
      orgId: org.id,
      createdBy: owner.id,
      name: "public-one",
      kind: "public",
    });
    const priv = await createTestChannel(db, {
      orgId: org.id,
      createdBy: owner.id,
      name: "private-secret",
      kind: "private",
    });

    expect(await visibleChannelIds(db, org.id, bystander.id)).toEqual([pub.id].sort());
    expect(await visibleChannelIds(db, org.id, owner.id)).toEqual([pub.id, priv.id].sort());
  });

  it("exposes a private channel once the user is added as a member", async () => {
    const owner = await createTestUser(db);
    const joiner = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await addOrgMember(db, org.id, joiner.id);

    const priv = await createTestChannel(db, {
      orgId: org.id,
      createdBy: owner.id,
      name: "private-room",
      kind: "private",
    });

    expect(await visibleChannelIds(db, org.id, joiner.id)).toEqual([]);
    await db.insert(channelMember).values({ channelId: priv.id, userId: joiner.id });
    expect(await visibleChannelIds(db, org.id, joiner.id)).toEqual([priv.id]);
  });
});
