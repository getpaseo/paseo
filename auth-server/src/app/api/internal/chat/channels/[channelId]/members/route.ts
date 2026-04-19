import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { channelMember } from "@/db/schema";
import { db } from "@/lib/db";
import { requireInternalSecret } from "@/lib/chat/internal-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const forbidden = requireInternalSecret(request);
  if (forbidden) return forbidden;
  const { channelId } = await params;
  const rows = await db
    .select({
      userId: channelMember.userId,
      role: channelMember.role,
    })
    .from(channelMember)
    .where(eq(channelMember.channelId, channelId));
  return NextResponse.json({ members: rows });
}
