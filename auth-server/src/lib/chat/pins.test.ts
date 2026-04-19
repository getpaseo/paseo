import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChannel } from "./channels";
import { sendMessage, deleteMessage } from "./messages";
import { listPinnedMessages, pinMessage, unpinMessage } from "./pins";
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
  const alice = await createTestUser(db);
  const bob = await createTestUser(db);
  const org = await createTestOrg(db, alice.id);
  await addOrgMember(db, org.id, bob.id);
  const chan = await createChannel(db, {
    orgId: org.id,
    userId: alice.id,
    name: "main",
    kind: "public",
  });
  const msg = await sendMessage(db, {
    channelId: chan.id,
    userId: alice.id,
    content: "important",
  });
  return { alice, bob, org, chan, msg };
}

describe("pins", () => {
  it("pins and lists a message", async () => {
    const { alice, chan, msg } = await scenario();
    await pinMessage(db, { channelId: chan.id, messageId: msg.id, userId: alice.id });
    const pins = await listPinnedMessages(db, { channelId: chan.id, userId: alice.id });
    expect(pins).toHaveLength(1);
    expect(pins[0]?.messageId).toBe(msg.id);
    expect(pins[0]?.message.authorName).toBe(alice.name);
  });

  it("is idempotent on double-pin", async () => {
    const { alice, chan, msg } = await scenario();
    await pinMessage(db, { channelId: chan.id, messageId: msg.id, userId: alice.id });
    await expect(
      pinMessage(db, { channelId: chan.id, messageId: msg.id, userId: alice.id }),
    ).resolves.toBeUndefined();
  });

  it("hides soft-deleted messages from the list without removing the pin row", async () => {
    const { alice, chan, msg } = await scenario();
    await pinMessage(db, { channelId: chan.id, messageId: msg.id, userId: alice.id });
    await deleteMessage(db, { messageId: msg.id, userId: alice.id });
    const pins = await listPinnedMessages(db, { channelId: chan.id, userId: alice.id });
    expect(pins).toHaveLength(0);
  });

  it("non-pinner non-admin cannot unpin", async () => {
    const { alice, bob, chan, msg } = await scenario();
    await pinMessage(db, { channelId: chan.id, messageId: msg.id, userId: alice.id });
    await expect(
      unpinMessage(db, { channelId: chan.id, messageId: msg.id, userId: bob.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("pinner can unpin themselves", async () => {
    const { alice, chan, msg } = await scenario();
    await pinMessage(db, { channelId: chan.id, messageId: msg.id, userId: alice.id });
    await unpinMessage(db, {
      channelId: chan.id,
      messageId: msg.id,
      userId: alice.id,
    });
    const pins = await listPinnedMessages(db, { channelId: chan.id, userId: alice.id });
    expect(pins).toHaveLength(0);
  });

  it("refuses to pin across channels", async () => {
    const { alice, org, msg } = await scenario();
    const other = await createChannel(db, {
      orgId: org.id,
      userId: alice.id,
      name: "other",
      kind: "public",
    });
    await expect(
      pinMessage(db, { channelId: other.id, messageId: msg.id, userId: alice.id }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});
