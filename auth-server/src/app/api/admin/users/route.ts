import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { user } from "@/db/schema";
import { like, or, desc, count } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";

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
    whereClause = or(like(user.name, `%${search}%`), like(user.email, `%${search}%`));
  }

  const users = await db
    .select()
    .from(user)
    .where(whereClause)
    .orderBy(desc(user.createdAt))
    .limit(limit)
    .offset(offset);

  const [total] = await db.select({ count: count() }).from(user).where(whereClause);

  return NextResponse.json({
    users,
    pagination: {
      total: total.count,
      page,
      limit,
      pages: Math.ceil(total.count / limit),
    },
  });
}
