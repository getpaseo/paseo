import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { archiveChannel } from "@/lib/chat/channels";
import { chatErrorResponse } from "@/lib/chat/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { channelId } = await params;
  try {
    await archiveChannel(db, { channelId, userId: me.id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
