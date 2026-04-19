import { randomUUID } from "node:crypto";
import { channel, channelMember, member, organization, user } from "@/db/schema";
import type { TestDb } from "./db";

export async function createTestUser(
  db: TestDb,
  overrides: Partial<{ name: string; email: string }> = {},
): Promise<{ id: string; email: string; name: string }> {
  const id = `user_${randomUUID()}`;
  const email = overrides.email ?? `${id}@test.local`;
  const name = overrides.name ?? `Test ${id}`;
  await db.insert(user).values({ id, name, email, emailVerified: true });
  return { id, email, name };
}

export async function createTestOrg(
  db: TestDb,
  ownerId: string,
  overrides: Partial<{ name: string; slug: string }> = {},
): Promise<{ id: string; slug: string }> {
  const id = `org_${randomUUID()}`;
  const slug = overrides.slug ?? id;
  await db.insert(organization).values({
    id,
    name: overrides.name ?? `Org ${id}`,
    slug,
  });
  await db.insert(member).values({
    id: `mem_${randomUUID()}`,
    organizationId: id,
    userId: ownerId,
    role: "owner",
  });
  return { id, slug };
}

export async function addOrgMember(
  db: TestDb,
  orgId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member",
): Promise<void> {
  await db.insert(member).values({
    id: `mem_${randomUUID()}`,
    organizationId: orgId,
    userId,
    role,
  });
}

export async function createTestChannel(
  db: TestDb,
  params: {
    orgId: string;
    createdBy: string;
    name?: string | null;
    kind?: "public" | "private" | "dm";
  },
): Promise<{ id: string }> {
  const id = `chan_${randomUUID()}`;
  await db.insert(channel).values({
    id,
    orgId: params.orgId,
    name: params.name === undefined ? `chan-${id.slice(-6)}` : params.name,
    kind: params.kind ?? "public",
    createdBy: params.createdBy,
  });
  await db.insert(channelMember).values({
    channelId: id,
    userId: params.createdBy,
    role: "admin",
  });
  return { id };
}
