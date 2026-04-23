import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { getSkillsCatalog } from "@/lib/library/catalog/service";

export async function GET(request: NextRequest) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const refresh = url.searchParams.get("refresh") === "1";
  try {
    const page = await getSkillsCatalog(db, { refresh, query });
    return NextResponse.json({
      items: page.items,
      nextCursor: null,
      totalCount: page.items.length,
    });
  } catch (err) {
    console.error("[catalog] skills fetch failed", err);
    return NextResponse.json({ error: "Catalog temporarily unavailable" }, { status: 503 });
  }
}
