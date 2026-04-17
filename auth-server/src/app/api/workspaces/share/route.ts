import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { workspaceShare, member, user as userTable } from "@/db/schema";
import { eq, and, isNull, desc } from "drizzle-orm";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { randomUUID, randomBytes } from "crypto";

/**
 * POST /api/workspaces/share — Create a workspace share
 */
export async function POST(request: NextRequest) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const body = await request.json();
  const {
    workspaceId,
    serverId,
    projectId,
    projectName,
    workspaceName,
    orgId,
    accessLevel = "read_only",
    pairingUrl,
    allowedUserIds = [],
    expiresInMinutes,
  } = body;

  if (!workspaceId || !serverId || !projectId || !orgId) {
    return NextResponse.json(
      { error: "workspaceId, serverId, projectId and orgId are required" },
      { status: 400 },
    );
  }

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, authUser.id)),
  });
  if (!membership) {
    return NextResponse.json({ error: "Not a member of this organization" }, { status: 403 });
  }

  const shareId = randomUUID();
  const token = randomBytes(8).toString("base64url");
  const now = new Date();
  const expiresAt = expiresInMinutes ? new Date(Date.now() + expiresInMinutes * 60 * 1000) : null;

  try {
    await db.insert(workspaceShare).values({
      id: shareId,
      token,
      workspaceId,
      serverId,
      projectId,
      projectName: projectName ?? projectId,
      workspaceName: workspaceName ?? workspaceId,
      orgId,
      ownerId: authUser.id,
      accessLevel,
      pairingUrl: pairingUrl || null,
      allowedUserIds: allowedUserIds as string[],
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[workspaces/share POST] insert failed:", message);
    return NextResponse.json(
      {
        error:
          message.includes("workspace_share") || message.includes("relation")
            ? `Database not migrated — run \`npm --prefix auth-server run db:push\`: ${message}`
            : message,
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      shareId,
      token,
      shareUrl: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3002"}/join-workspace/${token}`,
      accessLevel,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    },
    { status: 201 },
  );
}

/**
 * GET /api/workspaces/share?orgId=... — List shares owned by the current user
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
        eq(workspaceShare.ownerId, authUser.id),
        isNull(workspaceShare.revokedAt),
      ),
      orderBy: [desc(workspaceShare.createdAt)],
    });

    const allUserIds = new Set<string>();
    for (const s of shares) {
      for (const uid of (s.allowedUserIds as string[]) ?? []) allUserIds.add(uid);
    }

    const users = allUserIds.size
      ? await db.query.user.findMany({
          where: (u, { inArray }) => inArray(u.id, Array.from(allUserIds)),
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u] as const));

    return NextResponse.json({
      shares: shares.map((s) => ({
        shareId: s.id,
        token: s.token,
        workspaceId: s.workspaceId,
        serverId: s.serverId,
        projectId: s.projectId,
        projectName: s.projectName,
        workspaceName: s.workspaceName,
        orgId: s.orgId,
        accessLevel: s.accessLevel,
        allowedUserIds: (s.allowedUserIds as string[]) ?? [],
        allowedUsers: ((s.allowedUserIds as string[]) ?? []).map((uid) => {
          const u = userById.get(uid);
          return {
            userId: uid,
            name: u?.name ?? "Unknown",
            email: u?.email ?? "",
            image: u?.image ?? null,
          };
        }),
        expiresAt: s.expiresAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
        shareUrl: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3002"}/join-workspace/${s.token}`,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[workspaces/share GET] failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

void userTable;
