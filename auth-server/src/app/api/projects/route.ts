import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projectRegistry, member, user as userTable } from "@/db/schema";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";

/**
 * GET /api/projects?orgId=... — List projects registered in the org.
 *
 * Returns every member-visible project (not just the caller's). Paths live on
 * each user's daemon — this response only carries shareable identity + the
 * optional git remote so other members can clone locally.
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

    const rows = await db.query.projectRegistry.findMany({
      where: eq(projectRegistry.orgId, orgId),
      orderBy: [desc(projectRegistry.lastSeenAt)],
    });

    const ownerIds = Array.from(new Set(rows.map((r) => r.ownerId)));
    const owners = ownerIds.length
      ? await db.query.user.findMany({
          where: (u, { inArray }) => inArray(u.id, ownerIds),
        })
      : [];
    const ownerById = new Map(owners.map((u) => [u.id, u] as const));

    return NextResponse.json({
      projects: rows.map((r) => ({
        id: r.id,
        orgId: r.orgId,
        projectKey: r.projectKey,
        name: r.name,
        description: r.description,
        iconEmoji: r.iconEmoji,
        iconColor: r.iconColor,
        gitRemoteUrl: r.gitRemoteUrl,
        defaultBranch: r.defaultBranch,
        lastSeenAt: r.lastSeenAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        owner: {
          userId: r.ownerId,
          name: ownerById.get(r.ownerId)?.name ?? "Unknown",
          email: ownerById.get(r.ownerId)?.email ?? "",
          image: ownerById.get(r.ownerId)?.image ?? null,
        },
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[projects GET] failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

void userTable;
