import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addChannelMember,
  archiveChannel,
  ChatError,
  createChannel,
  listChannelMembers,
  listChannelsForUser,
  listDmsForUser,
  openDm,
  removeChannelMember,
} from "./channels";
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

describe("createChannel", () => {
  it("creates a public channel and makes creator an admin", async () => {
    const owner = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    const chan = await createChannel(db, {
      orgId: org.id,
      userId: owner.id,
      name: "General",
      kind: "public",
    });
    expect(chan.name).toBe("general"); // slugified
    expect(chan.kind).toBe("public");
    expect(chan.isMember).toBe(true);
    expect(chan.memberCount).toBe(1);
  });

  it("rejects user who isn't in the org", async () => {
    const owner = await createTestUser(db);
    const outsider = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await expect(
      createChannel(db, {
        orgId: org.id,
        userId: outsider.id,
        name: "intruder",
        kind: "public",
      }),
    ).rejects.toMatchObject({ code: "not_org_member" });
  });

  it("returns conflict on duplicate name within org", async () => {
    const owner = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await createChannel(db, { orgId: org.id, userId: owner.id, name: "dup", kind: "public" });
    await expect(
      createChannel(db, { orgId: org.id, userId: owner.id, name: "DUP", kind: "public" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects invalid names", async () => {
    const owner = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await expect(
      createChannel(db, { orgId: org.id, userId: owner.id, name: "   ", kind: "public" }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("listChannelsForUser", () => {
  it("returns public channels and privates where user is a member; skips DMs", async () => {
    const owner = await createTestUser(db);
    const friend = await createTestUser(db);
    const bystander = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await addOrgMember(db, org.id, friend.id);
    await addOrgMember(db, org.id, bystander.id);

    const pub = await createChannel(db, {
      orgId: org.id,
      userId: owner.id,
      name: "public-1",
      kind: "public",
    });
    const priv = await createChannel(db, {
      orgId: org.id,
      userId: owner.id,
      name: "private-1",
      kind: "private",
    });
    await addChannelMember(db, {
      channelId: priv.id,
      userId: friend.id,
      addedBy: owner.id,
    });
    await openDm(db, { orgId: org.id, userId: owner.id, otherUserIds: [friend.id] });

    const bystanderView = await listChannelsForUser(db, org.id, bystander.id);
    expect(bystanderView.map((c) => c.id)).toEqual([pub.id]);

    const friendView = await listChannelsForUser(db, org.id, friend.id);
    expect(new Set(friendView.map((c) => c.id))).toEqual(new Set([pub.id, priv.id]));

    const ownerView = await listChannelsForUser(db, org.id, owner.id);
    expect(new Set(ownerView.map((c) => c.id))).toEqual(new Set([pub.id, priv.id]));
  });
});

describe("addChannelMember / removeChannelMember", () => {
  it("private channel requires inviter to be a member", async () => {
    const owner = await createTestUser(db);
    const outsider = await createTestUser(db);
    const invitee = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await addOrgMember(db, org.id, outsider.id);
    await addOrgMember(db, org.id, invitee.id);
    const priv = await createChannel(db, {
      orgId: org.id,
      userId: owner.id,
      name: "hush",
      kind: "private",
    });
    await expect(
      addChannelMember(db, {
        channelId: priv.id,
        userId: invitee.id,
        addedBy: outsider.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // Owner is in channel — add works.
    await expect(
      addChannelMember(db, {
        channelId: priv.id,
        userId: invitee.id,
        addedBy: owner.id,
      }),
    ).resolves.toBeUndefined();
  });

  it("adding the same user twice is idempotent", async () => {
    const owner = await createTestUser(db);
    const friend = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await addOrgMember(db, org.id, friend.id);
    const pub = await createChannel(db, {
      orgId: org.id,
      userId: owner.id,
      name: "room",
      kind: "public",
    });
    await addChannelMember(db, { channelId: pub.id, userId: friend.id, addedBy: owner.id });
    await expect(
      addChannelMember(db, { channelId: pub.id, userId: friend.id, addedBy: owner.id }),
    ).resolves.toBeUndefined();
  });

  it("a user can always remove themselves; non-admins can't remove others", async () => {
    const owner = await createTestUser(db);
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await addOrgMember(db, org.id, a.id);
    await addOrgMember(db, org.id, b.id);
    const pub = await createChannel(db, {
      orgId: org.id,
      userId: owner.id,
      name: "lobby",
      kind: "public",
    });
    await addChannelMember(db, { channelId: pub.id, userId: a.id, addedBy: owner.id });
    await addChannelMember(db, { channelId: pub.id, userId: b.id, addedBy: owner.id });

    // A (plain member) tries to remove B → forbidden
    await expect(
      removeChannelMember(db, { channelId: pub.id, userId: b.id, removedBy: a.id }),
    ).rejects.toMatchObject({ code: "forbidden" });

    // A removes themself → ok
    await expect(
      removeChannelMember(db, { channelId: pub.id, userId: a.id, removedBy: a.id }),
    ).resolves.toBeUndefined();

    // Owner (channel admin) removes B → ok
    await expect(
      removeChannelMember(db, { channelId: pub.id, userId: b.id, removedBy: owner.id }),
    ).resolves.toBeUndefined();
  });

  it("rejects membership ops on DMs", async () => {
    const owner = await createTestUser(db);
    const other = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await addOrgMember(db, org.id, other.id);
    const dm = await openDm(db, {
      orgId: org.id,
      userId: owner.id,
      otherUserIds: [other.id],
    });
    await expect(
      addChannelMember(db, { channelId: dm.id, userId: other.id, addedBy: owner.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("archiveChannel", () => {
  it("only channel admins can archive", async () => {
    const owner = await createTestUser(db);
    const friend = await createTestUser(db);
    const org = await createTestOrg(db, owner.id);
    await addOrgMember(db, org.id, friend.id);
    const pub = await createChannel(db, {
      orgId: org.id,
      userId: owner.id,
      name: "x",
      kind: "public",
    });
    await addChannelMember(db, { channelId: pub.id, userId: friend.id, addedBy: owner.id });
    await expect(
      archiveChannel(db, { channelId: pub.id, userId: friend.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      archiveChannel(db, { channelId: pub.id, userId: owner.id }),
    ).resolves.toBeUndefined();
  });
});

describe("openDm", () => {
  it("is idempotent for the same sorted set of users", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    const org = await createTestOrg(db, a.id);
    await addOrgMember(db, org.id, b.id);
    const dm1 = await openDm(db, { orgId: org.id, userId: a.id, otherUserIds: [b.id] });
    const dm2 = await openDm(db, { orgId: org.id, userId: b.id, otherUserIds: [a.id] });
    expect(dm1.id).toBe(dm2.id);
  });

  it("creates distinct DMs for different participant sets", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    const c = await createTestUser(db);
    const org = await createTestOrg(db, a.id);
    await addOrgMember(db, org.id, b.id);
    await addOrgMember(db, org.id, c.id);
    const ab = await openDm(db, { orgId: org.id, userId: a.id, otherUserIds: [b.id] });
    const ac = await openDm(db, { orgId: org.id, userId: a.id, otherUserIds: [c.id] });
    const abc = await openDm(db, {
      orgId: org.id,
      userId: a.id,
      otherUserIds: [b.id, c.id],
    });
    expect(new Set([ab.id, ac.id, abc.id]).size).toBe(3);
  });

  it("refuses to DM a user outside the org", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    const org = await createTestOrg(db, a.id);
    await expect(
      openDm(db, { orgId: org.id, userId: a.id, otherUserIds: [b.id] }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("listDmsForUser & listChannelMembers", () => {
  it("returns DMs the user is part of, scoped to org when requested", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    const org1 = await createTestOrg(db, a.id);
    const org2 = await createTestOrg(db, a.id);
    await addOrgMember(db, org1.id, b.id);
    await addOrgMember(db, org2.id, b.id);
    const dm1 = await openDm(db, { orgId: org1.id, userId: a.id, otherUserIds: [b.id] });
    const dm2 = await openDm(db, { orgId: org2.id, userId: a.id, otherUserIds: [b.id] });
    const all = await listDmsForUser(db, { userId: a.id });
    expect(new Set(all.map((d) => d.id))).toEqual(new Set([dm1.id, dm2.id]));
    const onlyOrg1 = await listDmsForUser(db, { userId: a.id, orgId: org1.id });
    expect(onlyOrg1.map((d) => d.id)).toEqual([dm1.id]);
  });

  it("channel members blocks non-members from reading private channel roster", async () => {
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
      listChannelMembers(db, priv.id, outsider.id),
    ).rejects.toMatchObject({ code: "forbidden" });
    const roster = await listChannelMembers(db, priv.id, owner.id);
    expect(roster.map((r) => r.userId)).toEqual([owner.id]);
  });
});

describe("ChatError typing sanity", () => {
  it("errors carry a stable `code` field", () => {
    const e = new ChatError("forbidden", "nope");
    expect(e.code).toBe("forbidden");
    expect(e).toBeInstanceOf(Error);
  });
});
