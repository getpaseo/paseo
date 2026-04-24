import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Handle CORS preflight for API routes
  if (request.method === "OPTIONS" && pathname.startsWith("/api/")) {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }

  // Public routes - no auth needed
  const publicPaths = ["/health", "/sign-in", "/join", "/api/auth", "/api/v1/auth"];
  if (publicPaths.some((p) => pathname.startsWith(p))) {
    const response = NextResponse.next();
    if (pathname.startsWith("/api/")) {
      applyCorsHeaders(response, request);
    }
    return response;
  }

  // Stripe webhook - no auth needed
  if (pathname === "/api/billing/webhook") {
    return NextResponse.next();
  }

  // API routes - add CORS headers
  if (pathname.startsWith("/api/")) {
    const response = NextResponse.next();
    applyCorsHeaders(response, request);
    return response;
  }

  // Dashboard and admin routes need session cookie
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/admin")) {
    const sessionCookie =
      request.cookies.get("better-auth.session_token") ??
      request.cookies.get("__Secure-better-auth.session_token");

    if (!sessionCookie) {
      const signInUrl = new URL("/sign-in", request.url);
      signInUrl.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(signInUrl);
    }
  }

  return NextResponse.next();
}

function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };
}

function applyCorsHeaders(response: NextResponse, request: NextRequest) {
  const headers = corsHeaders(request);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
