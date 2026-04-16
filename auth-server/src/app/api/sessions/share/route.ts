import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionShare, member } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { randomUUID, randomBytes } from "crypto";

/**
 * POST /api/sessions/share — Create a share token
 */
export async function POST(request: NextRequest) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const body = await request.json();
  const {
    daemonSessionId,
    serverId,
    orgId,
    accessLevel = "read_only",
    pairingUrl,
    allowedUserIds = [],
    expiresInMinutes = 480,
  } = body;

  if (!daemonSessionId || !serverId) {
    return NextResponse.json(
      { error: "daemonSessionId and serverId are required" },
      { status: 400 },
    );
  }

  // If orgId provided, verify caller is a member
  if (orgId) {
    const membership = await db.query.member.findFirst({
      where: and(eq(member.organizationId, orgId), eq(member.userId, authUser.id)),
    });
    if (!membership) {
      return NextResponse.json({ error: "Not a member of this organization" }, { status: 403 });
    }
  }

  const shareId = randomUUID();
  const token = randomBytes(6).toString("base64url"); // Short, URL-safe token

  await db.insert(sessionShare).values({
    id: shareId,
    token,
    daemonSessionId,
    serverId,
    orgId: orgId || null,
    ownerId: authUser.id,
    accessLevel,
    pairingUrl: pairingUrl || null,
    allowedUserIds: allowedUserIds as string[],
    maxParticipants: 5,
    expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000),
  });

  return NextResponse.json(
    {
      shareId,
      token,
      shareUrl: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3002"}/join/${token}`,
      accessLevel,
      expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString(),
    },
    { status: 201 },
  );
}
