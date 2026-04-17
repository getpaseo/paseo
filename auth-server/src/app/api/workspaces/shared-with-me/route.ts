import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workspaceShare, member, user as userTable } from "@/db/schema";
import { eq, and, isNull, desc, or, gt } from "drizzle-orm";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";

/**
 * GET /api/workspaces/shared-with-me?orgId=... — List workspaces shared with the current user
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await authenticateRequest(request);
    if (!authUser) return unauthorized();

    const orgId = request.nextUrl.searchParams.get("orgId");
    if (!orgId) {
      return NextResponse.json({ error: "orgId is required" }, { status: 400 });
    }

    const membership = await db.query.member.findFirst({
      where: and(eq(member.organizationId, orgId), eq(member.userId, authUser.id)),
    });
    if (!membership) {
      return NextResponse.json({ error: "Not a member of this organization" }, { status: 403 });
    }

    const shares = await db.query.workspaceShare.findMany({
      where: and(
        eq(workspaceShare.orgId, orgId),
        isNull(workspaceShare.revokedAt),
        or(isNull(workspaceShare.expiresAt), gt(workspaceShare.expiresAt, new Date())),
      ),
      orderBy: [desc(workspaceShare.createdAt)],
    });

    const filtered = shares.filter((s) => {
      if (s.ownerId === authUser.id) return false;
      const allowed = (s.allowedUserIds as string[]) ?? [];
      return allowed.length === 0 || allowed.includes(authUser.id);
    });

    const ownerIds = Array.from(new Set(filtered.map((s) => s.ownerId)));
    const owners = ownerIds.length
      ? await db.query.user.findMany({
          where: (u, { inArray }) => inArray(u.id, ownerIds),
        })
      : [];
    const ownerById = new Map(owners.map((o) => [o.id, o] as const));

    return NextResponse.json({
      shares: filtered.map((s) => {
        const owner = ownerById.get(s.ownerId);
        return {
          shareId: s.id,
          token: s.token,
          workspaceId: s.workspaceId,
          serverId: s.serverId,
          projectId: s.projectId,
          projectName: s.projectName,
          workspaceName: s.workspaceName,
          orgId: s.orgId,
          accessLevel: s.accessLevel,
          pairingUrl: s.pairingUrl ?? null,
          owner: {
            userId: s.ownerId,
            name: owner?.name ?? "Unknown",
            email: owner?.email ?? "",
            image: owner?.image ?? null,
          },
          expiresAt: s.expiresAt?.toISOString() ?? null,
          createdAt: s.createdAt.toISOString(),
          shareUrl: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3002"}/join-workspace/${s.token}`,
        };
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[workspaces/shared-with-me GET] failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

void userTable;
