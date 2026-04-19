import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projectRegistry, member } from "@/db/schema";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";

/**
 * POST /api/projects/upsert — Upsert a lightweight project registry entry.
 *
 * Called by clients (desktop/web/mobile) whenever a project is opened so the
 * org keeps an up-to-date index of which projects exist and where they live
 * (git remote). No filesystem paths are stored — only shareable identity.
 *
 * Dedup: uniqueness on (orgId, projectKey). The first caller becomes ownerId;
 * subsequent callers bump lastSeenAt and refresh mutable fields (name, icon,
 * remote) but do not transfer ownership.
 */
export async function POST(request: NextRequest) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const body = await request.json().catch(() => ({}));
  const {
    orgId,
    projectKey,
    name,
    description,
    gitRemoteUrl,
    defaultBranch,
    iconEmoji,
    iconColor,
  } = body as Record<string, unknown>;

  if (typeof orgId !== "string" || typeof projectKey !== "string" || typeof name !== "string") {
    return NextResponse.json({ error: "orgId, projectKey and name are required" }, { status: 400 });
  }

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, authUser.id)),
  });
  if (!membership) {
    return NextResponse.json({ error: "Not a member of this organization" }, { status: 403 });
  }

  const now = new Date();
  const existing = await db.query.projectRegistry.findFirst({
    where: and(eq(projectRegistry.orgId, orgId), eq(projectRegistry.projectKey, projectKey)),
  });

  try {
    if (existing) {
      await db
        .update(projectRegistry)
        .set({
          name,
          description: typeof description === "string" ? description : existing.description,
          gitRemoteUrl: typeof gitRemoteUrl === "string" ? gitRemoteUrl : existing.gitRemoteUrl,
          defaultBranch: typeof defaultBranch === "string" ? defaultBranch : existing.defaultBranch,
          iconEmoji: typeof iconEmoji === "string" ? iconEmoji : existing.iconEmoji,
          iconColor: typeof iconColor === "string" ? iconColor : existing.iconColor,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(projectRegistry.id, existing.id));
      return NextResponse.json({ id: existing.id, created: false });
    }

    const id = randomUUID();
    await db.insert(projectRegistry).values({
      id,
      orgId,
      ownerId: authUser.id,
      projectKey,
      name,
      description: typeof description === "string" ? description : null,
      gitRemoteUrl: typeof gitRemoteUrl === "string" ? gitRemoteUrl : null,
      defaultBranch: typeof defaultBranch === "string" ? defaultBranch : null,
      iconEmoji: typeof iconEmoji === "string" ? iconEmoji : null,
      iconColor: typeof iconColor === "string" ? iconColor : null,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return NextResponse.json({ id, created: true }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[projects/upsert] failed:", message);
    return NextResponse.json(
      {
        error:
          message.includes("project_registry") || message.includes("relation")
            ? `Database not migrated — run \`npm --prefix auth-server run db:push\`: ${message}`
            : message,
      },
      { status: 500 },
    );
  }
}
