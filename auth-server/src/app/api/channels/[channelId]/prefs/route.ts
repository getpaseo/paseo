import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { updateChannelPrefs, type NotifyPref } from "@/lib/chat/channels";
import { chatErrorResponse } from "@/lib/chat/http";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { channelId } = await params;
  let body: { pref?: string; muted?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const pref =
    body.pref === "all" || body.pref === "mentions" || body.pref === "nothing"
      ? (body.pref as NotifyPref)
      : undefined;
  const muted = typeof body.muted === "boolean" ? body.muted : undefined;
  if (!pref && muted === undefined) {
    return NextResponse.json({ error: "pref or muted required" }, { status: 400 });
  }
  try {
    await updateChannelPrefs(db, { channelId, userId: me.id, pref, muted });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
