import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { user, organization, subscription, plan } from "@/db/schema";
import { eq, count } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const [userCount] = await db.select({ count: count() }).from(user);
  const [orgCount] = await db.select({ count: count() }).from(organization);
  const [activeSubCount] = await db
    .select({ count: count() })
    .from(subscription)
    .where(eq(subscription.status, "active"));

  // Calculate MRR
  const activeSubs = await db.query.subscription.findMany({
    where: eq(subscription.status, "active"),
  });

  let mrr = 0;
  for (const sub of activeSubs) {
    const p = await db.query.plan.findFirst({ where: eq(plan.id, sub.planId) });
    if (p) mrr += p.monthlyPriceCents;
  }

  const [canceledCount] = await db
    .select({ count: count() })
    .from(subscription)
    .where(eq(subscription.status, "canceled"));

  return NextResponse.json({
    totalUsers: userCount.count,
    totalOrganizations: orgCount.count,
    activeSubscriptions: activeSubCount.count,
    mrr: mrr / 100,
    canceledSubscriptions: canceledCount.count,
  });
}
