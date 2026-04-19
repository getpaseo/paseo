import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { chatErrorResponse } from "@/lib/chat/http";
import { deleteMessage, editMessage } from "@/lib/chat/messages";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { messageId } = await params;
  let body: { content?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const msg = await editMessage(db, {
      messageId,
      userId: me.id,
      content: typeof body.content === "string" ? body.content : "",
    });
    return NextResponse.json({ message: msg });
  } catch (err) {
    return chatErrorResponse(err);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { messageId } = await params;
  try {
    await deleteMessage(db, { messageId, userId: me.id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
