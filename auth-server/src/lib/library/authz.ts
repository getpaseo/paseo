import { and, eq } from "drizzle-orm";
import type { DbLike } from "@/lib/chat/authz";
import { member, projectRegistry } from "@/db/schema";
import type { LibraryScope } from "./types";

/**
 * Returns true when `userId` is allowed to **see** entries scoped under the
 * given (scope, scopeId). Visibility is enforced separately in the SELECT
 * (private entries are filtered to creator only).
 *
 * Rules:
 *   - user scope: always allowed for the caller (no cross-user reads).
 *   - org scope: caller must be a member of the org.
 *   - project scope: caller must be a member of the org that owns the project.
 */
export async function canReadScope(
  db: DbLike,
  userId: string,
  scope: LibraryScope,
  scopeId: string | null,
): Promise<boolean> {
  if (scope === "user") return true;
  if (scope === "org") {
    if (!scopeId) return false;
    const rows = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, scopeId), eq(member.userId, userId)))
      .limit(1);
    return rows.length > 0;
  }
  if (scope === "project") {
    if (!scopeId) return false;
    const project = await db
      .select({ orgId: projectRegistry.orgId })
      .from(projectRegistry)
      .where(eq(projectRegistry.id, scopeId))
      .limit(1);
    const orgId = project[0]?.orgId;
    if (!orgId) return false;
    return canReadScope(db, userId, "org", orgId);
  }
  return false;
}

/**
 * Returns true when `userId` is allowed to **write** entries scoped under
 * (scope, scopeId). Same rules as read for now — every member of an org/
 * project can recommend an MCP/skill. We may tighten this to admins later
 * once moderation needs surface.
 */
export async function canWriteScope(
  db: DbLike,
  userId: string,
  scope: LibraryScope,
  scopeId: string | null,
): Promise<boolean> {
  return canReadScope(db, userId, scope, scopeId);
}
