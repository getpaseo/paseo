import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { session, user } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { auth } from "@/lib/auth";

/**
 * GET /api/auth/get-session
 *
 * Returns the current session + user. Supports two auth modes so both the
 * desktop app (bearer token stored in the PKCE flow) and web pages (Better
 * Auth cookie session) can call the same endpoint.
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");

    // Mode 1: desktop / bearer token
    if (authHeader?.startsWith("Bearer ")) {
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
    }

    // Mode 2: browser / Better Auth cookie session
    try {
      const result = await auth.api.getSession({ headers: request.headers });
      if (!result?.user) {
        return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
      }
      const u = result.user as {
        id: string;
        name: string;
        email: string;
        image: string | null;
        role?: string;
        banned?: boolean;
      };
      if (u.banned) {
        return NextResponse.json({ error: "Account is suspended" }, { status: 403 });
      }
      return NextResponse.json({
        session: result.session,
        user: {
          id: u.id,
          name: u.name,
          email: u.email,
          image: u.image,
          role: (u.role as string) ?? "user",
        },
      });
    } catch {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
  } catch (error) {
    console.error("Get session error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
