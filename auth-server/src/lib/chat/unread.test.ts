import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChannel, listChannelsForUser, markChannelRead } from "./channels";
import { sendMessage } from "./messages";
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

describe("unread counters", () => {
  it("counts messages after last_read_at, excluding my own", async () => {
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
    // Bob joins to make him a "member" for unread accounting.
    await db.execute(
      `INSERT INTO channel_member (channel_id, user_id, role) VALUES ('${chan.id}', '${bob.id}', 'member')`,
    );

    await sendMessage(db, { channelId: chan.id, userId: bob.id, content: "hi 1" });
    await sendMessage(db, { channelId: chan.id, userId: bob.id, content: "hi 2" });
    await sendMessage(db, { channelId: chan.id, userId: alice.id, content: "mine" });

    const aliceView = await listChannelsForUser(db, org.id, alice.id);
    const myRow = aliceView.find((c) => c.id === chan.id);
    expect(myRow?.unreadCount).toBe(2); // 2 from bob, excludes alice's own.

    await markChannelRead(db, { channelId: chan.id, userId: alice.id });
    const after = await listChannelsForUser(db, org.id, alice.id);
    expect(after.find((c) => c.id === chan.id)?.unreadCount).toBe(0);

    // New message after read reappears in unread count.
    await sendMessage(db, { channelId: chan.id, userId: bob.id, content: "hi 3" });
    const afterNew = await listChannelsForUser(db, org.id, alice.id);
    expect(afterNew.find((c) => c.id === chan.id)?.unreadCount).toBe(1);
  });

  it("flags hasMention when the user is mentioned in unread range", async () => {
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
    await db.execute(
      `INSERT INTO channel_member (channel_id, user_id, role) VALUES ('${chan.id}', '${bob.id}', 'member')`,
    );

    await sendMessage(db, { channelId: chan.id, userId: bob.id, content: "no tag" });
    await sendMessage(db, {
      channelId: chan.id,
      userId: bob.id,
      content: `hey <@${alice.id}>`,
    });

    const view = await listChannelsForUser(db, org.id, alice.id);
    expect(view.find((c) => c.id === chan.id)?.hasMention).toBe(true);

    await markChannelRead(db, { channelId: chan.id, userId: alice.id });
    const after = await listChannelsForUser(db, org.id, alice.id);
    expect(after.find((c) => c.id === chan.id)?.hasMention).toBe(false);
  });
});
