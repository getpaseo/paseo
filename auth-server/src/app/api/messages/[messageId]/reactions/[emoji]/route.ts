import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { chatErrorResponse } from "@/lib/chat/http";
import { removeReaction } from "@/lib/chat/reactions";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string; emoji: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { messageId, emoji } = await params;
  try {
    await removeReaction(db, {
      messageId,
      userId: me.id,
      emoji: decodeURIComponent(emoji),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
