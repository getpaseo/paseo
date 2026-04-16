import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { invitation, member } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";

type Params = { params: Promise<{ orgId: string; invitationId: string }> };

/**
 * DELETE /api/organizations/:orgId/invitations/:invitationId - Cancel an invitation
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const user = await authenticateRequest(request);
  if (!user) return unauthorized();

  const { orgId, invitationId } = await params;

  // Verify caller is owner or admin
  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, user.id)),
  });
  if (!membership || !["owner", "admin"].includes(membership.role)) return forbidden();

  // Find the invitation
  const inv = await db.query.invitation.findFirst({
    where: and(
      eq(invitation.id, invitationId),
      eq(invitation.organizationId, orgId),
      eq(invitation.status, "pending"),
    ),
  });

  if (!inv) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }

  // Update status to canceled
  await db.update(invitation).set({ status: "canceled" }).where(eq(invitation.id, invitationId));

  return NextResponse.json({ success: true, message: "Invitation canceled" });
}

/**
 * POST /api/organizations/:orgId/invitations/:invitationId/resend - Resend invitation email
 */
export async function POST(request: NextRequest, { params }: Params) {
  const user = await authenticateRequest(request);
  if (!user) return unauthorized();

  const { orgId, invitationId } = await params;

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, user.id)),
  });
  if (!membership || !["owner", "admin"].includes(membership.role)) return forbidden();

  const inv = await db.query.invitation.findFirst({
    where: and(
      eq(invitation.id, invitationId),
      eq(invitation.organizationId, orgId),
      eq(invitation.status, "pending"),
    ),
  });

  if (!inv) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }

  // Dynamically import to avoid issues if RESEND_API_KEY is not set
  const { sendInvitationEmail } = await import("@/lib/email");
  const { organization } = await import("@/db/schema");

  const org = await db.query.organization.findFirst({
    where: eq(organization.id, orgId),
  });

  const result = await sendInvitationEmail({
    to: inv.email,
    inviterName: user.name,
    organizationName: org?.name ?? "Your team",
    orgId,
    invitationId,
    role: inv.role ?? "member",
  });

  if (!result.success) {
    return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
  }

  return NextResponse.json({ success: true, message: "Invitation email resent" });
}
