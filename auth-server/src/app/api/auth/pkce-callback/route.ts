import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { pkceChallenge, authorizationCode, account } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { randomBytes, randomUUID } from "crypto";

/**
 * GET /api/auth/pkce-callback
 *
 * This is called after Better Auth completes the OAuth flow for desktop PKCE clients.
 * It generates an authorization code and redirects to the desktop's loopback server.
 */
export async function GET(request: NextRequest) {
  try {
    // Get the session from Better Auth (user was just authenticated)
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: "Authentication failed" }, { status: 401 });
    }

    // Find the state parameter - it should be in the URL or cookies
    const { searchParams } = request.nextUrl;
    const state = searchParams.get("state");

    if (!state) {
      return NextResponse.json({ error: "Missing state parameter" }, { status: 400 });
    }

    // Look up the PKCE challenge
    const challenge = await db.query.pkceChallenge.findFirst({
      where: and(eq(pkceChallenge.state, state), gt(pkceChallenge.expiresAt, new Date())),
    });

    if (!challenge) {
      return NextResponse.json({ error: "Invalid or expired PKCE challenge" }, { status: 400 });
    }

    // Get the user's OAuth account to retrieve the access token
    const userAccount = await db.query.account.findFirst({
      where: and(eq(account.userId, session.user.id), eq(account.providerId, challenge.providerId)),
    });

    // Generate a one-time authorization code
    const code = randomBytes(32).toString("base64url");

    await db.insert(authorizationCode).values({
      id: randomUUID(),
      code,
      state,
      userId: session.user.id,
      accessToken: userAccount?.accessToken || null,
      providerId: challenge.providerId,
      codeChallenge: challenge.codeChallenge,
      codeChallengeMethod: challenge.codeChallengeMethod,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
    });

    // Redirect to the desktop's loopback server via an intermediate page.
    // If the loopback server is no longer running (timeout, retry, etc.)
    // the user sees a friendly message instead of ERR_CONNECTION_REFUSED.
    const redirectUrl = new URL(challenge.redirectUri);
    redirectUrl.searchParams.set("code", code);
    redirectUrl.searchParams.set("state", state);
    const target = redirectUrl.toString();

    const html = `<!DOCTYPE html>
<html><head><title>Signed in</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#09090b;color:#e5e5e5}
.c{text-align:center;max-width:360px;padding:2rem}
.check{width:48px;height:48px;margin:0 auto 1.25rem;border-radius:50%;background:#18181b;display:flex;align-items:center;justify-content:center}
.check svg{width:24px;height:24px;color:#22c55e}
h1{font-size:1.125rem;font-weight:600;margin-bottom:.375rem}
p{font-size:.8125rem;color:#71717a;line-height:1.5}
</style></head><body>
<div class="c">
<div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div>
<h1>Signed in successfully</h1>
<p>You can close this tab and return to Hubcode.</p>
</div>
<img src=${JSON.stringify(target)} style="display:none" alt="">
</body></html>`;

    return new NextResponse(html, {
      headers: { "Content-Type": "text/html" },
    });
  } catch (error) {
    console.error("PKCE callback error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
