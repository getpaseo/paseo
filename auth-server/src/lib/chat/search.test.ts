import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChannel, openDm } from "./channels";
import { sendMessage } from "./messages";
import { listMyMentions, searchMessages } from "./search";
import { setupTestDb, resetDb, teardownTestDb, type TestDb } from "@/test/db";
import { addOrgMember, createTestOrg, createTestUser } from "@/test/fixtures";

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

describe("searchMessages", () => {
  it("matches case-insensitively in public channels of the org", async () => {
    const alice = await createTestUser(db);
    const org = await createTestOrg(db, alice.id);
    const chan = await createChannel(db, {
      orgId: org.id,
      userId: alice.id,
      name: "gen",
      kind: "public",
    });
    await sendMessage(db, { channelId: chan.id, userId: alice.id, content: "Hello WORLD" });
    await sendMessage(db, { channelId: chan.id, userId: alice.id, content: "other stuff" });

    const hits = await searchMessages(db, {
      orgId: org.id,
      userId: alice.id,
      query: "world",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe("Hello WORLD");
  });

  it("skips private channels the user doesn't belong to", async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    const org = await createTestOrg(db, alice.id);
    await addOrgMember(db, org.id, bob.id);
    const priv = await createChannel(db, {
      orgId: org.id,
      userId: alice.id,
      name: "vip",
      kind: "private",
    });
    await sendMessage(db, { channelId: priv.id, userId: alice.id, content: "classified" });
    const hits = await searchMessages(db, {
      orgId: org.id,
      userId: bob.id,
      query: "classified",
    });
    expect(hits).toHaveLength(0);
  });

  it("returns [] for too-short queries", async () => {
    const alice = await createTestUser(db);
    const org = await createTestOrg(db, alice.id);
    const hits = await searchMessages(db, {
      orgId: org.id,
      userId: alice.id,
      query: "a",
    });
    expect(hits).toEqual([]);
  });

  it("ignores soft-deleted messages", async () => {
    const alice = await createTestUser(db);
    const org = await createTestOrg(db, alice.id);
    const chan = await createChannel(db, {
      orgId: org.id,
      userId: alice.id,
      name: "gen",
      kind: "public",
    });
    const m = await sendMessage(db, {
      channelId: chan.id,
      userId: alice.id,
      content: "findme",
    });
    await db.execute(`UPDATE message SET deleted_at = NOW() WHERE id = '${m.id}'`);
    const hits = await searchMessages(db, {
      orgId: org.id,
      userId: alice.id,
      query: "findme",
    });
    expect(hits).toHaveLength(0);
  });
});

describe("listMyMentions", () => {
  it("returns messages where the user was mentioned, newest first", async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    const org = await createTestOrg(db, alice.id);
    await addOrgMember(db, org.id, bob.id);
    const chan = await createChannel(db, {
      orgId: org.id,
      userId: alice.id,
      name: "gen",
      kind: "public",
    });
    await sendMessage(db, {
      channelId: chan.id,
      userId: bob.id,
      content: `hi <@${alice.id}> a`,
    });
    await sendMessage(db, {
      channelId: chan.id,
      userId: bob.id,
      content: `hey <@${alice.id}> b`,
    });
    await sendMessage(db, { channelId: chan.id, userId: bob.id, content: "no tag" });

    const hits = await listMyMentions(db, { orgId: org.id, userId: alice.id });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.content).toContain("b");
    expect(hits[1]?.content).toContain("a");
  });

  it("doesn't leak mentions from other orgs", async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    const orgA = await createTestOrg(db, alice.id);
    const orgB = await createTestOrg(db, alice.id);
    await addOrgMember(db, orgA.id, bob.id);
    await addOrgMember(db, orgB.id, bob.id);
    const chanA = await createChannel(db, {
      orgId: orgA.id,
      userId: alice.id,
      name: "gen",
      kind: "public",
    });
    const chanB = await createChannel(db, {
      orgId: orgB.id,
      userId: alice.id,
      name: "gen",
      kind: "public",
    });
    await sendMessage(db, {
      channelId: chanA.id,
      userId: bob.id,
      content: `hi <@${alice.id}> in A`,
    });
    await sendMessage(db, {
      channelId: chanB.id,
      userId: bob.id,
      content: `hi <@${alice.id}> in B`,
    });

    const hits = await listMyMentions(db, { orgId: orgA.id, userId: alice.id });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain("in A");
  });
});
