import { eq, inArray } from "drizzle-orm";
import { member, projectRegistry } from "@/db/schema";
import type { DbLike } from "@/lib/chat/authz";

/**
 * Resolve the set of orgs and projects the caller can see, used when listing
 * library entries without an explicit (scope, scopeId) filter. Pulled out as
 * its own helper because the entries module shouldn't know about org tables.
 */
export async function loadVisibleScopes(
  db: DbLike,
  userId: string,
): Promise<{ orgIds: string[]; projectIds: string[] }> {
  const orgs = await db
    .select({ orgId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  const orgIds = orgs.map((r) => r.orgId);
  if (orgIds.length === 0) return { orgIds: [], projectIds: [] };
  const projects = await db
    .select({ id: projectRegistry.id })
    .from(projectRegistry)
    .where(inArray(projectRegistry.orgId, orgIds));
  return { orgIds, projectIds: projects.map((p) => p.id) };
}
