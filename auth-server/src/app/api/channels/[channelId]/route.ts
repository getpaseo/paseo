import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { deleteChannel } from "@/lib/chat/channels";
import { chatErrorResponse } from "@/lib/chat/http";

/**
 * DELETE /api/channels/:channelId — permanently remove a channel. Admin only.
 * Cascades to members, messages, attachments, reactions, and pins via FKs.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { channelId } = await params;
  try {
    await deleteChannel(db, { channelId, userId: me.id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
