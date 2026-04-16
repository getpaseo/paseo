import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { activityLog, user } from "@/db/schema";
import { desc, count, eq } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const { searchParams } = request.nextUrl;
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "50");
  const offset = (page - 1) * limit;

  const logs = await db
    .select()
    .from(activityLog)
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
    .offset(offset);

  const [total] = await db.select({ count: count() }).from(activityLog);

  const logsWithUsers = await Promise.all(
    logs.map(async (log) => {
      const u = log.userId
        ? await db.query.user.findFirst({ where: eq(user.id, log.userId) })
        : null;
      return { ...log, userName: u?.name ?? null, userEmail: u?.email ?? null };
    }),
  );

  return NextResponse.json({
    activity: logsWithUsers,
    pagination: { total: total.count, page, limit, pages: Math.ceil(total.count / limit) },
  });
}
