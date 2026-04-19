const COLYSEUS_URL_DEV = "ws://localhost:6800";
const COLYSEUS_URL_PROD = "wss://colyseus.hubcode.ai";

function getColyseusUrl(): string {
  if (__DEV__) return COLYSEUS_URL_DEV;
  return COLYSEUS_URL_PROD;
}

export interface JoinSharedSessionOptions {
  shareToken: string;
  sessionToken: string;
}

// Use any for the Room type since we lazy-import colyseus.js
export type ColyseusRoom = any;
export type Room = any;

let _client: any = null;

async function getClient() {
  if (!_client) {
    const { Client } = await import("colyseus.js");
    _client = new Client(getColyseusUrl());
  }
  return _client;
}

export async function joinSharedSession(options: JoinSharedSessionOptions): Promise<ColyseusRoom> {
  const client = await getClient();
  return await client.joinOrCreate("shared_session", {
    shareToken: options.shareToken,
    sessionToken: options.sessionToken,
  });
}

export interface JoinOrgChatOptions {
  orgId: string;
  sessionToken: string;
}

export async function joinOrgChat(options: JoinOrgChatOptions): Promise<ColyseusRoom> {
  const client = await getClient();
  return await client.joinOrCreate("org_chat", {
    orgId: options.orgId,
    sessionToken: options.sessionToken,
  });
}
