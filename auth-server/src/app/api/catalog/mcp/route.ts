import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { getMcpCatalog } from "@/lib/library/catalog/service";

export async function GET(request: NextRequest) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? undefined;
  // Smithery paginates by integer page number. Still accept legacy
  // `?cursor=` from old clients for one release so they don't break mid-sync.
  const cursorRaw = url.searchParams.get("cursor");
  const page = cursorRaw ? Number.parseInt(cursorRaw, 10) : 1;
  const refresh = url.searchParams.get("refresh") === "1";
  const pageSize = url.searchParams.get("limit")
    ? Math.min(100, Number(url.searchParams.get("limit")))
    : undefined;
  try {
    const result = await getMcpCatalog(db, {
      query,
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize,
      refresh,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[catalog] mcp fetch failed", err);
    return NextResponse.json({ error: "Catalog temporarily unavailable" }, { status: 503 });
  }
}
