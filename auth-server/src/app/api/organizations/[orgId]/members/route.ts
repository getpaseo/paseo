import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { member, user, invitation, organization } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";
import { checkMemberLimit } from "@/lib/feature-flags";
import { randomUUID } from "crypto";

type Params = { params: Promise<{ orgId: string }> };

/**
 * GET /api/organizations/:orgId/members - List members
 */
export async function GET(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const { orgId } = await params;

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, authUser.id)),
  });
  if (!membership) return forbidden();

  const members = await db.query.member.findMany({
    where: eq(member.organizationId, orgId),
  });

  const membersWithUsers = await Promise.all(
    members.map(async (m) => {
      const u = await db.query.user.findFirst({
        where: eq(user.id, m.userId),
      });
      return {
        id: m.id,
        userId: m.userId,
        role: m.role,
        createdAt: m.createdAt,
        user: u ? { id: u.id, name: u.name, email: u.email, image: u.image } : null,
      };
    }),
  );

  // Also get pending invitations
  const invitations = await db.query.invitation.findMany({
    where: and(eq(invitation.organizationId, orgId), eq(invitation.status, "pending")),
  });

  return NextResponse.json({ members: membersWithUsers, invitations });
}

/**
 * POST /api/organizations/:orgId/members - Invite a member by email
 */
export async function POST(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const { orgId } = await params;

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, authUser.id)),
  });
  if (!membership || !["owner", "admin"].includes(membership.role)) return forbidden();

  const body = await request.json();
  const { email, role = "member" } = body;

  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  // Check member limit
  const limit = await checkMemberLimit(orgId);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `Member limit reached (${limit.current}/${limit.limit}). Upgrade your plan.`,
      },
      { status: 403 },
    );
  }

  // Check if user is already a member
  const existingUser = await db.query.user.findFirst({
    where: eq(user.email, email),
  });

  if (existingUser) {
    const existingMember = await db.query.member.findFirst({
      where: and(eq(member.organizationId, orgId), eq(member.userId, existingUser.id)),
    });
    if (existingMember) {
      return NextResponse.json({ error: "User is already a member" }, { status: 409 });
    }
  }

  // Check for pending invitation
  const existingInvite = await db.query.invitation.findFirst({
    where: and(
      eq(invitation.organizationId, orgId),
      eq(invitation.email, email),
      eq(invitation.status, "pending"),
    ),
  });
  if (existingInvite) {
    return NextResponse.json(
      { error: "Invitation already pending for this email" },
      { status: 409 },
    );
  }

  const inviteId = randomUUID();

  await db.insert(invitation).values({
    id: inviteId,
    organizationId: orgId,
    email,
    role,
    status: "pending",
    inviterId: authUser.id,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    createdAt: new Date(),
  });

  // If user already exists, auto-accept the invitation
  if (existingUser) {
    await db.insert(member).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: existingUser.id,
      role,
      createdAt: new Date(),
    });

    await db.update(invitation).set({ status: "accepted" }).where(eq(invitation.id, inviteId));

    return NextResponse.json(
      { id: inviteId, status: "accepted", message: "User added to organization" },
      { status: 201 },
    );
  }

  // Send invitation email via Resend (dynamic import to avoid crash if no API key)
  const org = await db.query.organization.findFirst({
    where: eq(organization.id, orgId),
  });

  const { sendInvitationEmail } = await import("@/lib/email");
  const emailResult = await sendInvitationEmail({
    to: email,
    inviterName: authUser.name,
    organizationName: org?.name ?? "Your team",
    orgId,
    invitationId: inviteId,
    role,
  });

  return NextResponse.json(
    {
      id: inviteId,
      status: "pending",
      message: "Invitation sent",
      emailSent: emailResult.success,
    },
    { status: 201 },
  );
}
