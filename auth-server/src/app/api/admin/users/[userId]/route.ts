import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { user, member, organization } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";
import { logActivity } from "@/lib/activity";

type Params = { params: Promise<{ userId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const { userId } = await params;

  const userRecord = await db.query.user.findFirst({
    where: eq(user.id, userId),
  });
  if (!userRecord) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const memberships = await db.query.member.findMany({
    where: eq(member.userId, userId),
  });

  const orgs = await Promise.all(
    memberships.map(async (m) => {
      const org = await db.query.organization.findFirst({
        where: eq(organization.id, m.organizationId),
      });
      return { ...org, role: m.role };
    }),
  );

  return NextResponse.json({ user: userRecord, organizations: orgs });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const { userId } = await params;
  const body = await request.json();

  const updates: Record<string, string | boolean | Date> = {};
  if (body.role !== undefined) updates.role = body.role;
  if (body.banned !== undefined) updates.banned = body.banned;
  updates.updatedAt = new Date();

  await db.update(user).set(updates).where(eq(user.id, userId));

  await logActivity({
    userId: authUser.id,
    action:
      body.banned !== undefined ? (body.banned ? "user.banned" : "user.unbanned") : "user.updated",
    resourceType: "user",
    resourceId: userId,
    details: updates,
  });

  const updated = await db.query.user.findFirst({ where: eq(user.id, userId) });
  return NextResponse.json(updated);
}
