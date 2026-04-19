import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";

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

  const at = new AccessToken(apiKey, apiSecret, {
    identity: authUser.id,
    name: authUser.name ?? "Guest",
    metadata: JSON.stringify({ avatarUrl: authUser.image ?? "" }),
    ttl: 60 * 60 * 4,
  });
  at.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const token = await at.toJwt();
  return NextResponse.json({ token, wsUrl });
}
