import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { invitation, member, organization } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { randomUUID } from "crypto";

/**
 * POST /api/invite/accept - Accept an invitation
 * Body: { invitationId, orgId }
 */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) return unauthorized();

  const { invitationId, orgId } = await request.json();

  if (!invitationId || !orgId) {
    return NextResponse.json({ error: "invitationId and orgId are required" }, { status: 400 });
  }

  // Find the invitation
  const inv = await db.query.invitation.findFirst({
    where: and(
      eq(invitation.id, invitationId),
      eq(invitation.organizationId, orgId),
      eq(invitation.status, "pending"),
    ),
  });

  if (!inv) {
    return NextResponse.json(
      { error: "Invitation not found or already processed" },
      { status: 404 },
    );
  }

  // Check if invitation is for this user's email
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
    return NextResponse.json(
      { error: "This invitation was sent to a different email address" },
      { status: 403 },
    );
  }

  // Check if expired
  if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) {
    await db.update(invitation).set({ status: "expired" }).where(eq(invitation.id, invitationId));
    return NextResponse.json({ error: "Invitation has expired" }, { status: 410 });
  }

  // Check if already a member
  const existingMember = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, user.id)),
  });

  if (existingMember) {
    // Mark invitation as accepted and return success
    await db.update(invitation).set({ status: "accepted" }).where(eq(invitation.id, invitationId));
    const org = await db.query.organization.findFirst({ where: eq(organization.id, orgId) });
    return NextResponse.json({
      success: true,
      message: "Already a member",
      organizationName: org?.name,
    });
  }

  // Add as member
  await db.insert(member).values({
    id: randomUUID(),
    organizationId: orgId,
    userId: user.id,
    role: inv.role ?? "member",
    createdAt: new Date(),
  });

  // Mark invitation as accepted
  await db.update(invitation).set({ status: "accepted" }).where(eq(invitation.id, invitationId));

  const org = await db.query.organization.findFirst({ where: eq(organization.id, orgId) });

  return NextResponse.json({
    success: true,
    message: "Invitation accepted",
    organizationName: org?.name,
  });
}
