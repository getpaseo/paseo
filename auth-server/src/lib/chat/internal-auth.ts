import { NextRequest, NextResponse } from "next/server";

/**
 * Authenticate a request from a trusted internal service (Colyseus, etc.).
 * The caller supplies the shared secret in `X-Internal-Secret`. The user
 * identity is passed explicitly in the request body — we trust Colyseus to
 * have already validated the token at connect-time.
 *
 * Returns null on success (= authorized), or a NextResponse to return.
 */
let loggedDevDefaultOnce = false;

function resolveExpectedSecret(): string | null {
  const fromEnv = process.env.COLYSEUS_INTERNAL_SECRET;
  if (fromEnv) return fromEnv;
  // Colyseus falls back to "dev-secret" when the env is missing (see
  // colyseus-server/src/config.ts). Mirror that here so local dev works
  // without both sides being configured. Production setups MUST set this.
  if (process.env.NODE_ENV !== "production") {
    if (!loggedDevDefaultOnce) {
      loggedDevDefaultOnce = true;
      console.warn(
        "[chat] COLYSEUS_INTERNAL_SECRET not set — using 'dev-secret' fallback (dev mode only)",
      );
    }
    return "dev-secret";
  }
  return null;
}

export function requireInternalSecret(request: NextRequest): NextResponse | null {
  const expected = resolveExpectedSecret();
  if (!expected) {
    return NextResponse.json(
      { error: "Internal API not configured" },
      { status: 503 },
    );
  }
  const got = request.headers.get("x-internal-secret");
  if (!got || got !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}
