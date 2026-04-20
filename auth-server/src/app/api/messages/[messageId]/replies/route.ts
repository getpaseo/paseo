import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { chatErrorResponse } from "@/lib/chat/http";
import { listThreadReplies, sendMessage, type MessageAttachmentInput } from "@/lib/chat/messages";
import { getMessageById } from "@/lib/chat/messages";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { messageId } = await params;
  try {
    const messages = await listThreadReplies(db, {
      parentMessageId: messageId,
      userId: me.id,
    });
    return NextResponse.json({ messages });
  } catch (err) {
    return chatErrorResponse(err);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { messageId } = await params;
  const parent = await getMessageById(db, messageId);
  if (!parent) {
    return NextResponse.json({ error: "Parent message not found" }, { status: 404 });
  }
  let body: { content?: string; attachments?: MessageAttachmentInput[] } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const msg = await sendMessage(db, {
      channelId: parent.channelId,
      userId: me.id,
      content: typeof body.content === "string" ? body.content : "",
      parentId: parent.parentId ?? messageId,
      attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
    });
    return NextResponse.json({ message: msg }, { status: 201 });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
