import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workspaceShare, member, user } from "@/db/schema";
import { eq, and, isNull, gt, or } from "drizzle-orm";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";

type Params = { params: Promise<{ token: string }> };

/**
 * GET /api/workspaces/share/:token — Validate a workspace share token
 */
export async function GET(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const { token } = await params;

  const share = await db.query.workspaceShare.findFirst({
    where: and(
      eq(workspaceShare.token, token),
      isNull(workspaceShare.revokedAt),
      or(isNull(workspaceShare.expiresAt), gt(workspaceShare.expiresAt, new Date())),
    ),
  });

  if (!share) {
    return NextResponse.json({ error: "Invalid, expired, or revoked share" }, { status: 404 });
  }

  const allowedIds = (share.allowedUserIds as string[]) ?? [];
  const isOwner = share.ownerId === authUser.id;
  if (!isOwner && allowedIds.length > 0 && !allowedIds.includes(authUser.id)) {
    return NextResponse.json({ error: "You are not invited to this workspace" }, { status: 403 });
  }

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, share.orgId), eq(member.userId, authUser.id)),
  });
  if (!membership) {
    return NextResponse.json({ error: "Not a member of this organization" }, { status: 403 });
  }

  const owner = await db.query.user.findFirst({ where: eq(user.id, share.ownerId) });

  return NextResponse.json({
    shareId: share.id,
    token: share.token,
    workspaceId: share.workspaceId,
    serverId: share.serverId,
    projectId: share.projectId,
    projectName: share.projectName,
    workspaceName: share.workspaceName,
    orgId: share.orgId,
    accessLevel: share.accessLevel,
    pairingUrl: share.pairingUrl ?? null,
    owner: {
      userId: owner?.id ?? share.ownerId,
      name: owner?.name ?? "Unknown",
      email: owner?.email ?? "",
      image: owner?.image ?? null,
    },
    currentUser: {
      userId: authUser.id,
      name: authUser.name,
      email: authUser.email,
      image: authUser.image,
      isOwner,
    },
    expiresAt: share.expiresAt?.toISOString() ?? null,
    createdAt: share.createdAt.toISOString(),
  });
}

/**
 * PATCH /api/workspaces/share/:token — Update a share (access level, members)
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const { token } = await params;
  const body = await request.json();

  const share = await db.query.workspaceShare.findFirst({
    where: eq(workspaceShare.token, token),
  });
  if (!share) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }
  if (share.ownerId !== authUser.id) {
    return NextResponse.json({ error: "Only the owner can update this share" }, { status: 403 });
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.accessLevel === "string") patch.accessLevel = body.accessLevel;
  if (Array.isArray(body.allowedUserIds)) patch.allowedUserIds = body.allowedUserIds as string[];
  if (typeof body.expiresInMinutes === "number") {
    patch.expiresAt = new Date(Date.now() + body.expiresInMinutes * 60 * 1000);
  } else if (body.expiresInMinutes === null) {
    patch.expiresAt = null;
  }

  await db.update(workspaceShare).set(patch).where(eq(workspaceShare.id, share.id));

  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/workspaces/share/:token — Revoke a share
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const { token } = await params;

  const share = await db.query.workspaceShare.findFirst({
    where: eq(workspaceShare.token, token),
  });
  if (!share) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }
  if (share.ownerId !== authUser.id) {
    return NextResponse.json({ error: "Only the owner can revoke this share" }, { status: 403 });
  }

  await db
    .update(workspaceShare)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaceShare.id, share.id));

  return NextResponse.json({ success: true });
}
