import { NextRequest, NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";

// Lists participants currently connected to a LiveKit room, so the pre-join
// screen can show who's already in the session. Requires the same auth as
// the token endpoint — we don't expose room state to unauthenticated users.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const room = request.nextUrl.searchParams.get("room");
  if (!room) {
    return NextResponse.json({ error: "room param required" }, { status: 400 });
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.LIVEKIT_WS_URL ?? "ws://localhost:7880";

  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: "LiveKit not configured" }, { status: 500 });
  }

  // RoomServiceClient uses the HTTP(S) form of the LiveKit URL.
  const httpUrl = wsUrl.replace(/^ws/, "http");
  const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);

  try {
    const participants = await svc.listParticipants(room);
    const out = participants.map((p) => {
      let avatarUrl: string | null = null;
      try {
        const meta = p.metadata ? (JSON.parse(p.metadata) as { avatarUrl?: string }) : null;
        avatarUrl = meta?.avatarUrl ?? null;
      } catch {}
      return {
        identity: p.identity,
        name: p.name || p.identity,
        avatarUrl,
      };
    });
    return NextResponse.json({ participants: out });
  } catch {
    // Room doesn't exist yet (nobody has joined) — return empty list.
    return NextResponse.json({ participants: [] });
  }
}
