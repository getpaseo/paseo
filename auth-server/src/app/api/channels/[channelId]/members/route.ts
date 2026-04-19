import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { addChannelMember, listChannelMembers } from "@/lib/chat/channels";
import { chatErrorResponse } from "@/lib/chat/http";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { channelId } = await params;
  try {
    const members = await listChannelMembers(db, channelId, me.id);
    return NextResponse.json({ members });
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

  let body: { userId?: string; role?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.userId || typeof body.userId !== "string") {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  const role = body.role === "admin" ? "admin" : "member";

  try {
    await addChannelMember(db, {
      channelId,
      userId: body.userId,
      addedBy: me.id,
      role,
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
