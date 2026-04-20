import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { channel } from "@/db/schema";
import { db } from "@/lib/db";
import { requireInternalSecret } from "@/lib/chat/internal-auth";

/**
 * Channel metadata lookup used by Colyseus to decide broadcast fan-out. For
 * public channels the room fans out to all connected org members (implicit
 * membership); for private/dm channels it restricts to explicit members.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const forbidden = requireInternalSecret(request);
  if (forbidden) return forbidden;
  const { channelId } = await params;
  const rows = await db
    .select({ id: channel.id, orgId: channel.orgId, kind: channel.kind })
    .from(channel)
    .where(eq(channel.id, channelId))
    .limit(1);
  const c = rows[0];
  if (!c) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  return NextResponse.json(c);
}
