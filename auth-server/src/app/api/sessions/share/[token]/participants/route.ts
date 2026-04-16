import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionShare, sessionParticipant, user } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";

type Params = { params: Promise<{ token: string }> };

async function resolveShareId(token: string): Promise<string | null> {
  const share = await db.query.sessionShare.findFirst({
    where: eq(sessionShare.token, token),
  });
  return share?.id ?? null;
}

/**
 * GET /api/sessions/share/:token/participants — List active participants
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { token } = await params;
  const shareId = await resolveShareId(token);
  if (!shareId) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }

  const participants = await db.query.sessionParticipant.findMany({
    where: and(eq(sessionParticipant.shareId, shareId), isNull(sessionParticipant.leftAt)),
  });

  const result = await Promise.all(
    participants.map(async (p) => {
      const u = await db.query.user.findFirst({ where: eq(user.id, p.userId) });
      return {
        userId: p.userId,
        username: u?.name ?? "Unknown",
        avatarUrl: u?.image ?? "",
        joinedAt: p.joinedAt?.toISOString() ?? "",
      };
    }),
  );

  return NextResponse.json({ participants: result });
}

/**
 * POST /api/sessions/share/:token/participants — Record join/leave
 *
 * Body: { userId: string, action: "join" | "leave" }
 */
export async function POST(request: NextRequest, { params }: Params) {
  const { token } = await params;
  const shareId = await resolveShareId(token);
  if (!shareId) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }

  const body = await request.json();
  const { userId, action } = body;

  if (!userId || !action) {
    return NextResponse.json({ error: "userId and action are required" }, { status: 400 });
  }

  if (action === "join") {
    const existing = await db.query.sessionParticipant.findFirst({
      where: and(
        eq(sessionParticipant.shareId, shareId),
        eq(sessionParticipant.userId, userId),
        isNull(sessionParticipant.leftAt),
      ),
    });

    if (!existing) {
      await db.insert(sessionParticipant).values({
        id: randomUUID(),
        shareId,
        userId,
      });
    }
  } else if (action === "leave") {
    const active = await db.query.sessionParticipant.findFirst({
      where: and(
        eq(sessionParticipant.shareId, shareId),
        eq(sessionParticipant.userId, userId),
        isNull(sessionParticipant.leftAt),
      ),
    });

    if (active) {
      await db
        .update(sessionParticipant)
        .set({ leftAt: new Date() })
        .where(eq(sessionParticipant.id, active.id));
    }
  }

  return NextResponse.json({ success: true });
}
