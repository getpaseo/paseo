import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChannel } from "./channels";
import { sendMessage } from "./messages";
import { addReaction, listReactions, removeReaction } from "./reactions";
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

async function scenario() {
  const owner = await createTestUser(db);
  const friend = await createTestUser(db);
  const org = await createTestOrg(db, owner.id);
  await addOrgMember(db, org.id, friend.id);
  const chan = await createChannel(db, {
    orgId: org.id,
    userId: owner.id,
    name: "gen",
    kind: "public",
  });
  const msg = await sendMessage(db, {
    channelId: chan.id,
    userId: owner.id,
    content: "something",
  });
  return { owner, friend, chan, msg };
}

describe("reactions", () => {
  it("adds a reaction and lists it grouped", async () => {
    const { owner, friend, msg } = await scenario();
    await addReaction(db, { messageId: msg.id, userId: owner.id, emoji: "👍" });
    await addReaction(db, { messageId: msg.id, userId: friend.id, emoji: "👍" });
    await addReaction(db, { messageId: msg.id, userId: owner.id, emoji: "🎉" });
    const groups = await listReactions(db, msg.id);
    const byEmoji = Object.fromEntries(groups.map((g) => [g.emoji, g]));
    expect(byEmoji["👍"]?.count).toBe(2);
    expect(byEmoji["👍"]?.userIds.sort()).toEqual([friend.id, owner.id].sort());
    expect(byEmoji["🎉"]?.count).toBe(1);
  });

  it("adding the same reaction twice is idempotent", async () => {
    const { owner, msg } = await scenario();
    await addReaction(db, { messageId: msg.id, userId: owner.id, emoji: "❤️" });
    await addReaction(db, { messageId: msg.id, userId: owner.id, emoji: "❤️" });
    const groups = await listReactions(db, msg.id);
    expect(groups.find((g) => g.emoji === "❤️")?.count).toBe(1);
  });

  it("removing a reaction only affects that user/emoji", async () => {
    const { owner, friend, msg } = await scenario();
    await addReaction(db, { messageId: msg.id, userId: owner.id, emoji: "👍" });
    await addReaction(db, { messageId: msg.id, userId: friend.id, emoji: "👍" });
    await removeReaction(db, { messageId: msg.id, userId: owner.id, emoji: "👍" });
    const groups = await listReactions(db, msg.id);
    expect(groups.find((g) => g.emoji === "👍")?.userIds).toEqual([friend.id]);
  });

  it("blocks reacting in a private channel you're not in", async () => {
    const owner = await createTestUser(db);
    const outsider = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await addOrgMember(db, org.id, outsider.id);
    const priv = await createChannel(db, {
      orgId: org.id,
      userId: owner.id,
      name: "hush",
      kind: "private",
    });
    const msg = await sendMessage(db, {
      channelId: priv.id,
      userId: owner.id,
      content: "secret",
    });
    await expect(
      addReaction(db, { messageId: msg.id, userId: outsider.id, emoji: "👀" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects malformed emoji", async () => {
    const { owner, msg } = await scenario();
    await expect(
      addReaction(db, { messageId: msg.id, userId: owner.id, emoji: "" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      addReaction(db, {
        messageId: msg.id,
        userId: owner.id,
        emoji: "bad\x01char",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});
