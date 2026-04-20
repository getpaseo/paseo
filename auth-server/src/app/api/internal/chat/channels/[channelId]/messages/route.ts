import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatErrorResponse } from "@/lib/chat/http";
import { requireInternalSecret } from "@/lib/chat/internal-auth";
import { listMessages, sendMessage, type MessageAttachmentInput } from "@/lib/chat/messages";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const forbidden = requireInternalSecret(request);
  if (forbidden) return forbidden;
  const { channelId } = await params;
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  const before = url.searchParams.get("before") ?? undefined;
  const after = url.searchParams.get("after") ?? undefined;
  const limit = url.searchParams.get("limit");
  try {
    const messages = await listMessages(db, {
      channelId,
      userId,
      before,
      after,
      limit: limit ? Number(limit) : undefined,
    });
    return NextResponse.json({ messages });
  } catch (err) {
    return chatErrorResponse(err);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const forbidden = requireInternalSecret(request);
  if (forbidden) return forbidden;
  const { channelId } = await params;
  let body: {
    userId?: string;
    content?: string;
    parentId?: string | null;
    quotedMessageId?: string | null;
    attachments?: MessageAttachmentInput[];
  } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  try {
    const msg = await sendMessage(db, {
      channelId,
      userId: body.userId,
      content: typeof body.content === "string" ? body.content : "",
      parentId: body.parentId ?? null,
      quotedMessageId: body.quotedMessageId ?? null,
      attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
    });
    return NextResponse.json({ message: msg }, { status: 201 });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
