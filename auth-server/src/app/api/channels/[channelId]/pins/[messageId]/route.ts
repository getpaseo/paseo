import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { unpinMessage } from "@/lib/chat/pins";
import { chatErrorResponse } from "@/lib/chat/http";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string; messageId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { channelId, messageId } = await params;
  try {
    await unpinMessage(db, { channelId, messageId, userId: me.id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
