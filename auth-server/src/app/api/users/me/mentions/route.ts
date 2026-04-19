import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { listMyMentions } from "@/lib/chat/search";
import { chatErrorResponse } from "@/lib/chat/http";

export async function GET(request: NextRequest) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const url = new URL(request.url);
  const orgId = url.searchParams.get("orgId");
  if (!orgId) {
    return NextResponse.json({ error: "orgId required" }, { status: 400 });
  }
  const limit = url.searchParams.get("limit");
  try {
    const hits = await listMyMentions(db, {
      orgId,
      userId: me.id,
      limit: limit ? Number(limit) : undefined,
    });
    return NextResponse.json({ hits });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
