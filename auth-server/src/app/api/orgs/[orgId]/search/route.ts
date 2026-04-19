import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { searchMessages } from "@/lib/chat/search";
import { chatErrorResponse } from "@/lib/chat/http";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { orgId } = await params;
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const channelId = url.searchParams.get("channelId") ?? undefined;
  const limit = url.searchParams.get("limit");
  try {
    const hits = await searchMessages(db, {
      orgId,
      userId: me.id,
      query: q,
      channelId: channelId || undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return NextResponse.json({ hits });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
