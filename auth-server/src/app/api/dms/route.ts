import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { chatErrorResponse } from "@/lib/chat/http";
import { listDmsForUser, openDm } from "@/lib/chat/channels";

export async function GET(request: NextRequest) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const url = new URL(request.url);
  const orgId = url.searchParams.get("orgId") ?? undefined;
  try {
    const channels = await listDmsForUser(db, { userId: me.id, orgId });
    return NextResponse.json({ channels });
  } catch (err) {
    return chatErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  let body: { orgId?: string; userIds?: string[] } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.orgId || typeof body.orgId !== "string") {
    return NextResponse.json({ error: "orgId required" }, { status: 400 });
  }
  if (!Array.isArray(body.userIds) || body.userIds.length === 0) {
    return NextResponse.json({ error: "userIds required" }, { status: 400 });
  }
  try {
    const channel = await openDm(db, {
      orgId: body.orgId,
      userId: me.id,
      otherUserIds: body.userIds,
    });
    return NextResponse.json({ channel }, { status: 201 });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
