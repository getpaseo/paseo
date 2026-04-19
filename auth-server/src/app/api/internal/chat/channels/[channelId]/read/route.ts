import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { markChannelRead } from "@/lib/chat/channels";
import { chatErrorResponse } from "@/lib/chat/http";
import { requireInternalSecret } from "@/lib/chat/internal-auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const forbidden = requireInternalSecret(request);
  if (forbidden) return forbidden;
  const { channelId } = await params;
  let body: { userId?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  try {
    await markChannelRead(db, { channelId, userId: body.userId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
