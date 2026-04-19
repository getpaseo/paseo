import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { createChannel, listChannelsForUser } from "@/lib/chat/channels";
import { chatErrorResponse } from "@/lib/chat/http";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { orgId } = await params;
  try {
    const channels = await listChannelsForUser(db, orgId, me.id);
    return NextResponse.json({ channels });
  } catch (err) {
    return chatErrorResponse(err);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { orgId } = await params;

  let body: { name?: string; kind?: string; topic?: string | null } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name : "";
  const kind = body.kind === "private" ? "private" : "public";
  const topic = typeof body.topic === "string" ? body.topic : null;

  try {
    const channel = await createChannel(db, {
      orgId,
      userId: me.id,
      name,
      kind,
      topic,
    });
    return NextResponse.json({ channel }, { status: 201 });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
