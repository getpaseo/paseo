import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { session, user } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";

/**
 * GET /api/auth/get-session
 *
 * Validates a bearer token session. Used by the desktop app.
 * Header: Authorization: Bearer {token}
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Missing authorization header" }, { status: 401 });
    }

    const token = authHeader.slice(7);

    const sessionRecord = await db.query.session.findFirst({
      where: and(eq(session.token, token), gt(session.expiresAt, new Date())),
    });

    if (!sessionRecord) {
      return NextResponse.json({ error: "Invalid or expired session" }, { status: 401 });
    }

    const userRecord = await db.query.user.findFirst({
      where: eq(user.id, sessionRecord.userId),
    });

    if (!userRecord) {
      return NextResponse.json({ error: "User not found" }, { status: 401 });
    }

    if (userRecord.banned) {
      return NextResponse.json({ error: "Account is suspended" }, { status: 403 });
    }

    return NextResponse.json({
      session: {
        id: sessionRecord.id,
        userId: sessionRecord.userId,
        expiresAt: sessionRecord.expiresAt,
      },
      user: {
        id: userRecord.id,
        name: userRecord.name,
        email: userRecord.email,
        image: userRecord.image,
        role: userRecord.role,
      },
    });
  } catch (error) {
    console.error("Get session error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
