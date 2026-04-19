import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { listPinnedMessages, pinMessage } from "@/lib/chat/pins";
import { chatErrorResponse } from "@/lib/chat/http";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { channelId } = await params;
  try {
    const pins = await listPinnedMessages(db, { channelId, userId: me.id });
    return NextResponse.json({ pins });
  } catch (err) {
    return chatErrorResponse(err);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { channelId } = await params;
  let body: { messageId?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.messageId) {
    return NextResponse.json({ error: "messageId required" }, { status: 400 });
  }
  try {
    await pinMessage(db, { channelId, messageId: body.messageId, userId: me.id });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
