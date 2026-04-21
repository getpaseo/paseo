import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { getMcpDetail } from "@/lib/library/catalog/service";

/**
 * Resolve connection details for a single catalog item. Hit when the user
 * opens the Add modal — returns the enriched CatalogItem with `install`
 * populated (URL or command/args) + `envVars` from the Smithery configSchema.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { id } = await params;
  try {
    const item = await getMcpDetail(db, decodeURIComponent(id));
    if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ item });
  } catch (err) {
    console.error("[catalog] mcp detail fetch failed", err);
    return NextResponse.json(
      { error: "Catalog temporarily unavailable" },
      { status: 503 },
    );
  }
}
