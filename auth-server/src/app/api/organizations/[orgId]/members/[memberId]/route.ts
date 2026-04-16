import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { member } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";

type Params = { params: Promise<{ orgId: string; memberId: string }> };

/**
 * PATCH /api/organizations/:orgId/members/:memberId - Update member role
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const { orgId, memberId } = await params;

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, authUser.id)),
  });
  if (!membership || !["owner", "admin"].includes(membership.role)) return forbidden();

  const body = await request.json();
  const { role } = body;

  if (!role || !["owner", "admin", "member"].includes(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  // Can't change owner role unless you're the owner
  const target = await db.query.member.findFirst({
    where: eq(member.id, memberId),
  });
  if (!target) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (target.role === "owner" && membership.role !== "owner") {
    return forbidden();
  }

  await db.update(member).set({ role }).where(eq(member.id, memberId));

  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/organizations/:orgId/members/:memberId - Remove member
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const { orgId, memberId } = await params;

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, authUser.id)),
  });
  if (!membership || !["owner", "admin"].includes(membership.role)) return forbidden();

  const target = await db.query.member.findFirst({
    where: eq(member.id, memberId),
  });
  if (!target) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  // Can't remove the owner
  if (target.role === "owner") {
    return NextResponse.json({ error: "Cannot remove the organization owner" }, { status: 400 });
  }

  await db.delete(member).where(eq(member.id, memberId));

  return NextResponse.json({ success: true });
}
