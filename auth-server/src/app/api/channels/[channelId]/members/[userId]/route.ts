import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { removeChannelMember } from "@/lib/chat/channels";
import { chatErrorResponse } from "@/lib/chat/http";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string; userId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { channelId, userId } = await params;
  try {
    await removeChannelMember(db, {
      channelId,
      userId,
      removedBy: me.id,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
