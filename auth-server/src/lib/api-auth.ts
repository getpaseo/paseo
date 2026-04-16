import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { db } from "./db";
import { session, user } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
}

/**
 * Extract and validate the session from a Bearer token or session cookie.
 * Returns the user or null.
 */
export async function authenticateRequest(request: NextRequest): Promise<AuthenticatedUser | null> {
  // Try Bearer token first (desktop app)
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const sessionRecord = await db.query.session.findFirst({
      where: and(eq(session.token, token), gt(session.expiresAt, new Date())),
    });
    if (!sessionRecord) return null;

    const userRecord = await db.query.user.findFirst({
      where: eq(user.id, sessionRecord.userId),
    });
    if (!userRecord || userRecord.banned) return null;

    return {
      id: userRecord.id,
      name: userRecord.name,
      email: userRecord.email,
      image: userRecord.image,
      role: userRecord.role,
    };
  }

  // Try better-auth session (handles cookie parsing internally)
  try {
    const result = await auth.api.getSession({
      headers: request.headers,
    });
    if (result?.user) {
      const u = result.user as {
        id: string;
        name: string;
        email: string;
        image: string | null;
        role?: string;
        banned?: boolean;
      };
      if (u.banned) return null;
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        image: u.image,
        role: (u.role as string) ?? "user",
      };
    }
  } catch {
    // fall through
  }

  return null;
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
