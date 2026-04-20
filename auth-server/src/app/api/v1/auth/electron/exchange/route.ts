import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizationCode, pkceChallenge, session, user } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "crypto";

/**
 * POST /api/v1/auth/electron/exchange
 *
 * Exchanges an authorization code + PKCE verifier for a session token.
 * This is the endpoint the desktop app calls after receiving the callback.
 *
 * Request body: { state, code, code_verifier }
 * Response: { sessionToken, accessToken, providerId, user }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { state, code, code_verifier } = body;

    if (!state || !code || !code_verifier) {
      return NextResponse.json(
        { error: "Missing required fields: state, code, code_verifier" },
        { status: 400 },
      );
    }

    // Look up the authorization code
    const authCode = await db.query.authorizationCode.findFirst({
      where: and(
        eq(authorizationCode.code, code),
        eq(authorizationCode.state, state),
        eq(authorizationCode.used, false),
        gt(authorizationCode.expiresAt, new Date()),
      ),
    });

    if (!authCode) {
      return NextResponse.json(
        { error: "Invalid, expired, or already used authorization code" },
        { status: 400 },
      );
    }

    // Verify PKCE
    if (authCode.codeChallenge && authCode.codeChallengeMethod === "S256") {
      const expectedChallenge = createHash("sha256").update(code_verifier).digest("base64url");

      if (expectedChallenge !== authCode.codeChallenge) {
        return NextResponse.json({ error: "PKCE verification failed" }, { status: 400 });
      }
    }

    // Mark the code as used
    await db
      .update(authorizationCode)
      .set({ used: true })
      .where(eq(authorizationCode.id, authCode.id));

    // Get the user
    const userRecord = await db.query.user.findFirst({
      where: eq(user.id, authCode.userId),
    });

    if (!userRecord) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (userRecord.banned) {
      return NextResponse.json({ error: "Account is suspended" }, { status: 403 });
    }

    // Create a new session
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await db.insert(session).values({
      id: sessionId,
      token: sessionToken,
      userId: userRecord.id,
      expiresAt: sessionExpiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Clean up the PKCE challenge
    await db.delete(pkceChallenge).where(eq(pkceChallenge.state, state));

    return NextResponse.json({
      sessionToken,
      accessToken: authCode.accessToken || "",
      providerId: authCode.providerId,
      // Authoritative server-side session expiry — the desktop app should
      // persist this as-is instead of inventing its own duration, otherwise
      // the stored session can claim to be valid after the server has already
      // rotated or expired the underlying row.
      expiresAt: sessionExpiresAt.toISOString(),
      user: {
        userId: userRecord.id,
        username: userRecord.name,
        avatarUrl: userRecord.image || "",
        email: userRecord.email,
      },
    });
  } catch (error) {
    console.error("Token exchange error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
