import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatErrorResponse } from "@/lib/chat/http";
import { requireInternalSecret } from "@/lib/chat/internal-auth";
import { deleteMessage, editMessage } from "@/lib/chat/messages";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const forbidden = requireInternalSecret(request);
  if (forbidden) return forbidden;
  const { messageId } = await params;
  let body: { userId?: string; content?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.userId || typeof body.content !== "string") {
    return NextResponse.json({ error: "userId and content required" }, { status: 400 });
  }
  try {
    const msg = await editMessage(db, {
      messageId,
      userId: body.userId,
      content: body.content,
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
  const forbidden = requireInternalSecret(request);
  if (forbidden) return forbidden;
  const { messageId } = await params;
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  try {
    await deleteMessage(db, { messageId, userId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
