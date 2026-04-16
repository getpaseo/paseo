import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { subscription, plan, user } from "@/db/schema";
import { eq, desc, count } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const { searchParams } = request.nextUrl;
  const status = searchParams.get("status");
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "20");
  const offset = (page - 1) * limit;

  const whereClause = status ? eq(subscription.status, status) : undefined;

  const subs = await db
    .select()
    .from(subscription)
    .where(whereClause)
    .orderBy(desc(subscription.createdAt))
    .limit(limit)
    .offset(offset);

  const [total] = await db.select({ count: count() }).from(subscription).where(whereClause);

  const subsWithDetails = await Promise.all(
    subs.map(async (s) => {
      const accountOwner = await db.query.user.findFirst({
        where: eq(user.id, s.userId),
      });
      const p = await db.query.plan.findFirst({ where: eq(plan.id, s.planId) });
      return {
        ...s,
        accountName: accountOwner?.name,
        accountEmail: accountOwner?.email,
        planName: p?.name,
      };
    }),
  );

  return NextResponse.json({
    subscriptions: subsWithDetails,
    pagination: { total: total.count, page, limit, pages: Math.ceil(total.count / limit) },
  });
}
