import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { pkceChallenge } from "@/db/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

/**
 * GET /sign-in
 *
 * Handles two flows:
 * 1. Desktop PKCE flow: Has redirect_uri pointing to 127.0.0.1 loopback.
 *    Stores PKCE challenge in DB, then renders an auto-submitting page
 *    that POSTs to better-auth's sign-in/social from the browser context
 *    (so OAuth state cookies are properly set in the user's browser).
 * 2. Web flow: No redirect_uri. Shows sign-in page.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const providerId = searchParams.get("provider_id");
  const state = searchParams.get("state");
  const redirectUri = searchParams.get("redirect_uri");
  const codeChallenge = searchParams.get("code_challenge");
  const codeChallengeMethod = searchParams.get("code_challenge_method");

  // Desktop PKCE flow
  if (state && redirectUri && codeChallenge) {
    // If provider is already known, store challenge and auto-redirect
    if (providerId) {
      // Upsert: the picker page may have already stored the challenge (without provider).
      // Update it with the chosen provider, or insert if coming directly with provider.
      const existing = await db.query.pkceChallenge.findFirst({
        where: eq(pkceChallenge.state, state),
      });
      if (existing) {
        await db.update(pkceChallenge).set({ providerId }).where(eq(pkceChallenge.state, state));
      } else {
        await db.insert(pkceChallenge).values({
          id: randomUUID(),
          state,
          codeChallenge,
          codeChallengeMethod: codeChallengeMethod || "S256",
          redirectUri,
          providerId,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        });
      }

      const baseUrl = process.env.BETTER_AUTH_URL || "http://localhost:3002";
      const callbackUrl = `${baseUrl}/api/auth/pkce-callback?state=${encodeURIComponent(state)}`;

      const baseUrlForLogo = process.env.BETTER_AUTH_URL || "http://localhost:3002";
      const spinnerCss = `@keyframes spin { to { transform: rotate(360deg) } }`;
      const html = `<!DOCTYPE html>
<html>
<head>
<title>Signing in...</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #09090b; color: #e5e5e5; }
  .container { text-align: center; }
  .logo { height: 40px; width: auto; margin-bottom: 1.5rem; }
  .spinner { width: 20px; height: 20px; border: 2px solid #27272a; border-top-color: #c026d3; border-radius: 50%; animation: spin 0.6s linear infinite; margin: 0 auto 1rem; }
  ${spinnerCss}
  p { font-size: 0.8125rem; color: #71717a; }
</style>
</head>
<body>
<div class="container">
  <img src="${baseUrlForLogo}/logo-hubcode.png" alt="Hubcode" class="logo" onerror="this.style.display='none'">
  <div class="spinner"></div>
  <p>Redirecting...</p>
</div>
<script>
fetch("/api/auth/sign-in/social", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "include",
  body: JSON.stringify({
    provider: ${JSON.stringify(providerId)},
    callbackURL: ${JSON.stringify(callbackUrl)},
    disableRedirect: true
  })
})
.then(r => r.json())
.then(data => {
  if (data.url) {
    window.location.href = data.url;
  } else {
    document.body.textContent = "Error: OAuth provider did not return a redirect URL.";
  }
})
.catch(err => {
  document.body.textContent = "Error: " + err.message;
});
</script>
</body>
</html>`;

      return new NextResponse(html, {
        headers: { "Content-Type": "text/html" },
      });
    }

    // No provider specified — show provider picker page.
    // PKCE params are forwarded so the chosen provider triggers the same flow.
    const baseUrl = process.env.BETTER_AUTH_URL || "http://localhost:3002";
    const pkceParams = new URLSearchParams({
      state,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod || "S256",
    }).toString();

    const html = `<!DOCTYPE html>
<html>
<head>
<title>Sign in to Hubcode</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #09090b; color: #e5e5e5; }
  .card { width: 100%; max-width: 380px; padding: 2.5rem 2rem; border-radius: 1rem; border: 1px solid #1e1e22; background: #111113; }
  .logo { display: block; height: 48px; width: auto; margin: 0 auto 2rem; }
  h1 { font-size: 1.125rem; font-weight: 600; text-align: center; margin-bottom: 0.375rem; letter-spacing: -0.01em; }
  .subtitle { font-size: 0.8125rem; color: #71717a; text-align: center; margin-bottom: 1.75rem; }
  .buttons { display: flex; flex-direction: column; gap: 0.5rem; }
  button { display: flex; align-items: center; justify-content: center; gap: 0.5rem; width: 100%; padding: 0.625rem 1rem; border-radius: 0.5rem; border: 1px solid #27272a; background: #18181b; color: #e5e5e5; font-size: 0.8125rem; font-weight: 500; cursor: pointer; transition: background 0.15s, border-color 0.15s; }
  button:hover { background: #27272a; border-color: #3f3f46; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button svg { width: 16px; height: 16px; flex-shrink: 0; }
  .footer { font-size: 0.6875rem; color: #3f3f46; text-align: center; margin-top: 1.5rem; line-height: 1.5; }
  .error { color: #ef4444; text-align: center; font-size: 0.8125rem; margin-top: 1rem; display: none; }
</style>
</head>
<body>
<div class="card">
  <img src="${baseUrl}/logo-hubcode.png" alt="Hubcode" class="logo" onerror="this.style.display='none'">
  <p class="subtitle">Choose how you want to sign in</p>
  <div class="buttons">
    <button onclick="startAuth('github')" id="btn-github">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
      Continue with GitHub
    </button>
    <button onclick="startAuth('google')" id="btn-google">
      <svg viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
      Continue with Google
    </button>
  </div>
  <p class="error" id="error-msg"></p>
  <p class="footer">By signing in, you agree to our Terms of Service and Privacy Policy.</p>
</div>
<script>
function startAuth(provider) {
  document.getElementById('btn-github').disabled = true;
  document.getElementById('btn-google').disabled = true;
  // Redirect to /sign-in with provider_id and the PKCE params
  window.location.href = '/sign-in?provider_id=' + provider + '&${pkceParams.replace(/'/g, "\\'")}';
}
</script>
</body>
</html>`;

    return new NextResponse(html, {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Web flow: redirect to dashboard sign-in page
  return NextResponse.redirect(new URL("/sign-in/web", request.url));
}
