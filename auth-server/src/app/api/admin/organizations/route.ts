import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organization, member } from "@/db/schema";
import { like, desc, count, eq } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";
import { getOrganizationBillingSummary } from "@/lib/billing";

export async function GET(request: NextRequest) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const { searchParams } = request.nextUrl;
  const search = searchParams.get("search") || "";
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "20");
  const offset = (page - 1) * limit;

  let whereClause;
  if (search) {
    whereClause = like(organization.name, `%${search}%`);
  }

  const orgs = await db
    .select()
    .from(organization)
    .where(whereClause)
    .orderBy(desc(organization.createdAt))
    .limit(limit)
    .offset(offset);

  const [total] = await db.select({ count: count() }).from(organization).where(whereClause);

  const orgsWithDetails = await Promise.all(
    orgs.map(async (org) => {
      const [memberCount] = await db
        .select({ count: count() })
        .from(member)
        .where(eq(member.organizationId, org.id));
      const billing = await getOrganizationBillingSummary(org.id);
      return {
        ...org,
        memberCount: memberCount.count,
        planName: billing.currentPlan?.name ?? "Free",
        subscriptionStatus: billing.subscriptionStatus,
      };
    }),
  );

  return NextResponse.json({
    organizations: orgsWithDetails,
    pagination: { total: total.count, page, limit, pages: Math.ceil(total.count / limit) },
  });
}
