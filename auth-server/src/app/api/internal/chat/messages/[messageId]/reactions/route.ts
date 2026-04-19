import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatErrorResponse } from "@/lib/chat/http";
import { requireInternalSecret } from "@/lib/chat/internal-auth";
import { addReaction, removeReaction } from "@/lib/chat/reactions";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const forbidden = requireInternalSecret(request);
  if (forbidden) return forbidden;
  const { messageId } = await params;
  let body: { userId?: string; emoji?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.userId || !body.emoji) {
    return NextResponse.json({ error: "userId and emoji required" }, { status: 400 });
  }
  try {
    await addReaction(db, { messageId, userId: body.userId, emoji: body.emoji });
    return NextResponse.json({ ok: true }, { status: 201 });
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
  const emoji = url.searchParams.get("emoji");
  if (!userId || !emoji) {
    return NextResponse.json({ error: "userId and emoji required" }, { status: 400 });
  }
  try {
    await removeReaction(db, { messageId, userId, emoji });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
