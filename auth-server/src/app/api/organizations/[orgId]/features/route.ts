import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { member } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getOrgFeatures } from "@/lib/feature-flags";

type Params = { params: Promise<{ orgId: string }> };

/**
 * GET /api/organizations/:orgId/features - Get resolved feature flags
 */
export async function GET(request: NextRequest, { params }: Params) {
  const user = await authenticateRequest(request);
  if (!user) return unauthorized();

  const { orgId } = await params;

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, user.id)),
  });
  if (!membership) return forbidden();

  const features = await getOrgFeatures(orgId);

  return NextResponse.json({ features });
}
