import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { chatErrorResponse } from "@/lib/chat/http";
import { addReaction, listReactions } from "@/lib/chat/reactions";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { messageId } = await params;
  try {
    const reactions = await listReactions(db, messageId);
    return NextResponse.json({ reactions });
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
  let body: { emoji?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.emoji || typeof body.emoji !== "string") {
    return NextResponse.json({ error: "emoji required" }, { status: 400 });
  }
  try {
    await addReaction(db, { messageId, userId: me.id, emoji: body.emoji });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
