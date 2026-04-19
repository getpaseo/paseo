import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { channel, channelMember } from "@/db/schema";
import { db } from "@/lib/db";
import { requireInternalSecret } from "@/lib/chat/internal-auth";

/**
 * Returns every channel (across all orgs) the user is an explicit member of.
 * Colyseus uses this on `onJoin` to scope broadcast targets.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const forbidden = requireInternalSecret(request);
  if (forbidden) return forbidden;
  const { userId } = await params;
  const rows = await db
    .select({
      id: channel.id,
      orgId: channel.orgId,
      kind: channel.kind,
    })
    .from(channelMember)
    .innerJoin(channel, eq(channel.id, channelMember.channelId))
    .where(eq(channelMember.userId, userId));
  return NextResponse.json({ channels: rows });
}
