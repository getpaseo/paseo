import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrFetchIcon } from "@/lib/library/catalog/icons";

/**
 * Public icon proxy. No auth — clients need this URL directly in `<img src>`
 * / `<Image source>` tags without juggling auth headers. The proxy only
 * serves whitelisted upstream hosts (GitHub avatars + known CDNs), so it
 * can't be abused as a general SSRF.
 */
const ALLOWED_HOSTS = new Set([
  "avatars.githubusercontent.com",
  "raw.githubusercontent.com",
  "api.pulsemcp.com",
  "www.pulsemcp.com",
  "cdn.pulsemcp.com",
  // Brand-logo CDN used as a per-domain logo lookup for catalog cards.
  "logo.clearbit.com",
  // Smithery's icon CDN — every listing ships a real product logo here.
  "api.smithery.ai",
  "registry.smithery.ai",
]);

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return NextResponse.json({ error: "Host not allowed" }, { status: 400 });
  }
  const result = await getOrFetchIcon(db, parsed.toString());
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "Content-Type": result.mimeType,
      // Cache at the edge for 7d; clients may cache indefinitely — the hash
      // embedded by the client guarantees fresh content.
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}
