import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionShare, sessionParticipant, user, member } from "@/db/schema";
import { eq, and, gt, isNull } from "drizzle-orm";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";

type Params = { params: Promise<{ token: string }> };

/**
 * GET /api/sessions/share/:token — Validate a share token
 *
 * Checks:
 * - Token exists and is not expired
 * - Requesting user is in allowedUserIds
 * - Requesting user is a member of the org
 *
 * Returns session info + access level for the joining client.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const { token } = await params;

  const share = await db.query.sessionShare.findFirst({
    where: and(eq(sessionShare.token, token), gt(sessionShare.expiresAt, new Date())),
  });

  if (!share) {
    return NextResponse.json({ error: "Invalid or expired share link" }, { status: 404 });
  }

  // Check if user is in allowedUserIds
  const allowedIds = share.allowedUserIds as string[];
  if (allowedIds.length > 0 && !allowedIds.includes(authUser.id)) {
    return NextResponse.json({ error: "You are not invited to this session" }, { status: 403 });
  }

  // Check org membership
  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, share.orgId), eq(member.userId, authUser.id)),
  });
  if (!membership) {
    return NextResponse.json({ error: "Not a member of this organization" }, { status: 403 });
  }

  // Get owner info
  const owner = await db.query.user.findFirst({
    where: eq(user.id, share.ownerId),
  });

  // Get current participants
  const participants = await db.query.sessionParticipant.findMany({
    where: and(eq(sessionParticipant.shareId, share.id), isNull(sessionParticipant.leftAt)),
  });

  const participantUsers = await Promise.all(
    participants.map(async (p) => {
      const u = await db.query.user.findFirst({ where: eq(user.id, p.userId) });
      return {
        userId: p.userId,
        username: u?.name ?? "Unknown",
        avatarUrl: u?.image ?? "",
        joinedAt: p.joinedAt?.toISOString() ?? "",
      };
    }),
  );

  return NextResponse.json({
    shareId: share.id,
    daemonSessionId: share.daemonSessionId,
    serverId: share.serverId,
    accessLevel: share.accessLevel,
    pairingUrl: share.pairingUrl ?? null,
    colyseusRoomId: `shared_session_${share.daemonSessionId}`,
    owner: {
      userId: owner?.id ?? share.ownerId,
      username: owner?.name ?? "Unknown",
      avatarUrl: owner?.image ?? "",
    },
    currentUser: {
      userId: authUser.id,
      username: authUser.name,
      avatarUrl: authUser.image ?? "",
      isOwner: authUser.id === share.ownerId,
    },
    participants: participantUsers,
  });
}

/**
 * DELETE /api/sessions/share/:token — Revoke a share (by token)
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const { token } = await params;

  const share = await db.query.sessionShare.findFirst({
    where: eq(sessionShare.token, token),
  });

  if (!share) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }

  if (share.ownerId !== authUser.id) {
    return NextResponse.json({ error: "Only the owner can revoke this share" }, { status: 403 });
  }

  await db.delete(sessionShare).where(eq(sessionShare.id, share.id));

  return NextResponse.json({ success: true });
}
