import { NextResponse } from "next/server";
import { AccessToken, type VideoGrant } from "livekit-server-sdk";

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;

export async function POST() {
  if (!LIVEKIT_API_KEY) {
    return NextResponse.json(
      { error: "LiveKit API key not configured" },
      { status: 500 }
    );
  }

  if (!LIVEKIT_API_SECRET) {
    return NextResponse.json(
      { error: "LiveKit API secret not configured" },
      { status: 500 }
    );
  }

  if (!LIVEKIT_URL) {
    return NextResponse.json(
      { error: "LiveKit URL not configured" },
      { status: 500 }
    );
  }

  try {
    console.log("Creating LiveKit token...");

    const participantIdentity = `voice_user_${Math.floor(
      Math.random() * 10_000
    )}`;
    const participantName = "user";
    const roomName = `voice_room_${Math.floor(Math.random() * 10_000)}`;

    console.log("LIVEKIT_URL", LIVEKIT_URL);
    console.log("LIVEKIT_API_KEY", LIVEKIT_API_KEY);
    console.log("LIVEKIT_API_SECRET", LIVEKIT_API_SECRET);
    console.log("participantIdentity", participantIdentity);
    console.log("participantName", participantName);
    console.log("roomName", roomName);

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: participantIdentity,
      name: participantName,
      ttl: "15m",
    });

    const grant: VideoGrant = {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
    };

    token.addGrant(grant);

    const jwt = await token.toJwt();

    return NextResponse.json({
      serverUrl: LIVEKIT_URL,
      roomName,
      participantToken: jwt,
      participantName,
    });
  } catch (error) {
    console.error("Token creation error:", error);
    return NextResponse.json(
      { error: "Failed to create token" },
      { status: 500 }
    );
  }
}
