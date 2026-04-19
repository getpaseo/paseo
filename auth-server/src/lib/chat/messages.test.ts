import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mention } from "@/db/schema";
import { createChannel, openDm } from "./channels";
import {
  deleteMessage,
  editMessage,
  extractMentionUserIds,
  listMessages,
  listThreadReplies,
  sendMessage,
} from "./messages";
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

async function publicChannel() {
  const owner = await createTestUser(db);
  const org = await createTestOrg(db, owner.id);
  const chan = await createChannel(db, {
    orgId: org.id,
    userId: owner.id,
    name: "general",
    kind: "public",
  });
  return { owner, org, chan };
}

describe("sendMessage", () => {
  it("persists a message and returns it with empty attachments", async () => {
    const { owner, chan } = await publicChannel();
    const msg = await sendMessage(db, {
      channelId: chan.id,
      userId: owner.id,
      content: "hello",
    });
    expect(msg.content).toBe("hello");
    expect(msg.attachments).toEqual([]);
  });

  it("rejects empty messages", async () => {
    const { owner, chan } = await publicChannel();
    await expect(
      sendMessage(db, { channelId: chan.id, userId: owner.id, content: "   " }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("allows empty content when attachments are provided", async () => {
    const { owner, chan } = await publicChannel();
    const msg = await sendMessage(db, {
      channelId: chan.id,
      userId: owner.id,
      content: "",
      attachments: [
        {
          url: "https://cdn/example/file.png",
          mimeType: "image/png",
          filename: "file.png",
          sizeBytes: 100,
          width: 200,
          height: 150,
        },
      ],
    });
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]?.filename).toBe("file.png");
  });

  it("refuses to write to a private channel the user isn't in", async () => {
    const owner = await createTestUser(db);
    const outsider = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await addOrgMember(db, org.id, outsider.id);
    const priv = await createChannel(db, {
      orgId: org.id,
      userId: owner.id,
      name: "vip",
      kind: "private",
    });
    await expect(
      sendMessage(db, { channelId: priv.id, userId: outsider.id, content: "hi" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a reply to a reply (only root → replies)", async () => {
    const { owner, chan } = await publicChannel();
    const root = await sendMessage(db, {
      channelId: chan.id,
      userId: owner.id,
      content: "root",
    });
    const reply = await sendMessage(db, {
      channelId: chan.id,
      userId: owner.id,
      content: "reply",
      parentId: root.id,
    });
    await expect(
      sendMessage(db, {
        channelId: chan.id,
        userId: owner.id,
        content: "reply to reply",
        parentId: reply.id,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("registers mentions for existing users, silently drops unknown ones", async () => {
    const owner = await createTestUser(db);
    const friend = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await addOrgMember(db, org.id, friend.id);
    const chan = await createChannel(db, {
      orgId: org.id,
      userId: owner.id,
      name: "talk",
      kind: "public",
    });
    const msg = await sendMessage(db, {
      channelId: chan.id,
      userId: owner.id,
      content: `hey <@${friend.id}> and <@ghost-user> and <@${friend.id}> again`,
    });
    const rows = await db.select().from(mention).where(eq(mention.messageId, msg.id));
    expect(rows.map((r) => r.userId).sort()).toEqual([friend.id]);
  });
});

describe("listMessages", () => {
  it("paginates backwards, stable under ties", async () => {
    const { owner, chan } = await publicChannel();
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) {
      const m = await sendMessage(db, {
        channelId: chan.id,
        userId: owner.id,
        content: `m${i}`,
      });
      ids.push(m.id);
    }
    // Expect oldest → newest chronology; sendMessage inserted in order.
    const page1 = await listMessages(db, {
      channelId: chan.id,
      userId: owner.id,
      limit: 50,
    });
    expect(page1.map((m) => m.id)).toEqual(ids.slice(70, 120));
    const page2 = await listMessages(db, {
      channelId: chan.id,
      userId: owner.id,
      limit: 50,
      before: page1[0]!.id,
    });
    expect(page2.map((m) => m.id)).toEqual(ids.slice(20, 70));
    const page3 = await listMessages(db, {
      channelId: chan.id,
      userId: owner.id,
      limit: 50,
      before: page2[0]!.id,
    });
    expect(page3.map((m) => m.id)).toEqual(ids.slice(0, 20));

    // No duplicates across pages; covers everything.
    const all = [...page3, ...page2, ...page1].map((m) => m.id);
    expect(all).toEqual(ids);
    expect(new Set(all).size).toBe(ids.length);
  });

  it("omits replies from channel listing; returns them via listThreadReplies", async () => {
    const { owner, chan } = await publicChannel();
    const root = await sendMessage(db, {
      channelId: chan.id,
      userId: owner.id,
      content: "root",
    });
    const reply = await sendMessage(db, {
      channelId: chan.id,
      userId: owner.id,
      content: "reply",
      parentId: root.id,
    });
    const main = await listMessages(db, { channelId: chan.id, userId: owner.id });
    expect(main.map((m) => m.id)).toEqual([root.id]);
    const thread = await listThreadReplies(db, {
      parentMessageId: root.id,
      userId: owner.id,
    });
    expect(thread.map((m) => m.id)).toEqual([reply.id]);
  });

  it("blocks non-members from reading private channel history", async () => {
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
    await sendMessage(db, { channelId: priv.id, userId: owner.id, content: "secret" });
    await expect(
      listMessages(db, { channelId: priv.id, userId: outsider.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("hides soft-deleted messages by default", async () => {
    const { owner, chan } = await publicChannel();
    const m = await sendMessage(db, {
      channelId: chan.id,
      userId: owner.id,
      content: "temp",
    });
    await deleteMessage(db, { messageId: m.id, userId: owner.id });
    const visible = await listMessages(db, { channelId: chan.id, userId: owner.id });
    expect(visible.find((x) => x.id === m.id)).toBeUndefined();
    const incl = await listMessages(db, {
      channelId: chan.id,
      userId: owner.id,
      includeDeleted: true,
    });
    expect(incl.find((x) => x.id === m.id)).toBeDefined();
    expect(incl.find((x) => x.id === m.id)?.content).toBe("");
  });
});

describe("editMessage / deleteMessage", () => {
  it("only author can edit", async () => {
    const owner = await createTestUser(db);
    const friend = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await addOrgMember(db, org.id, friend.id);
    const chan = await createChannel(db, {
      orgId: org.id,
      userId: owner.id,
      name: "c",
      kind: "public",
    });
    const m = await sendMessage(db, {
      channelId: chan.id,
      userId: owner.id,
      content: "orig",
    });
    await expect(
      editMessage(db, { messageId: m.id, userId: friend.id, content: "hacked" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const updated = await editMessage(db, {
      messageId: m.id,
      userId: owner.id,
      content: "edit",
    });
    expect(updated.content).toBe("edit");
    expect(updated.editedAt).toBeInstanceOf(Date);
  });

  it("channel admin can delete any message; non-author non-admin cannot", async () => {
    const owner = await createTestUser(db);
    const friend = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await addOrgMember(db, org.id, friend.id);
    const chan = await createChannel(db, {
      orgId: org.id,
      userId: owner.id,
      name: "c",
      kind: "public",
    });
    const friendMsg = await sendMessage(db, {
      channelId: chan.id,
      userId: friend.id,
      content: "spam",
    });
    // First, ensure friend can't be deleted by an unrelated plain member.
    const plain = await createTestUser(db);
    await addOrgMember(db, org.id, plain.id);
    await expect(
      deleteMessage(db, { messageId: friendMsg.id, userId: plain.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // Owner is org owner → canAdmin=true via resolveChannelAccess.
    await expect(
      deleteMessage(db, { messageId: friendMsg.id, userId: owner.id }),
    ).resolves.toBeUndefined();
  });
});

describe("extractMentionUserIds", () => {
  it("extracts unique user IDs from content", () => {
    const ids = extractMentionUserIds("hi <@alice> and <@bob> and <@alice>!");
    expect(ids.sort()).toEqual(["alice", "bob"]);
  });
  it("returns empty for no mentions", () => {
    expect(extractMentionUserIds("no mentions here")).toEqual([]);
  });
});

describe("DM write path", () => {
  it("DM members can send to each other; non-participant cannot", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    const c = await createTestUser(db);
    const org = await createTestOrg(db, a.id);
    await addOrgMember(db, org.id, b.id);
    await addOrgMember(db, org.id, c.id);
    const dm = await openDm(db, { orgId: org.id, userId: a.id, otherUserIds: [b.id] });
    const msg = await sendMessage(db, {
      channelId: dm.id,
      userId: b.id,
      content: "yo",
    });
    expect(msg.content).toBe("yo");
    await expect(
      sendMessage(db, { channelId: dm.id, userId: c.id, content: "snooping" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
