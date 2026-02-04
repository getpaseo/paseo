import os from "node:os";

import {
  ConnectionOfferV1Schema,
  type ConnectionOfferV1,
} from "../shared/connection-offer.js";

type BuildOfferEndpointsArgs = {
  listenHost: string;
  port: number;
};

export function buildOfferEndpoints({
  listenHost,
  port,
}: BuildOfferEndpointsArgs): string[] {
  const endpoints: string[] = [];

  const isLoopbackHost = listenHost === "127.0.0.1" || listenHost === "localhost";
  const isWildcardHost =
    listenHost === "0.0.0.0" || listenHost === "::" || listenHost === "[::]";

  if (isWildcardHost) {
    const lanIp = getPrimaryLanIp();
    if (lanIp) {
      endpoints.push(`${lanIp}:${port}`);
    }
  } else if (!isLoopbackHost) {
    endpoints.push(`${listenHost}:${port}`);
  }

  endpoints.push(`localhost:${port}`);
  endpoints.push(`127.0.0.1:${port}`);

  return dedupePreserveOrder(endpoints);
}

export async function createConnectionOfferV1(args: {
  sessionId: string;
  endpoints: string[];
  daemonPublicKeyB64: string;
  relay?: { endpoint: string } | null;
}): Promise<ConnectionOfferV1> {
  return ConnectionOfferV1Schema.parse({
    v: 1,
    sessionId: args.sessionId,
    endpoints: args.endpoints,
    daemonPublicKeyB64: args.daemonPublicKeyB64,
    relay: args.relay ?? null,
  });
}

export function encodeOfferToFragmentUrl(args: {
  offer: ConnectionOfferV1;
  appBaseUrl: string;
}): string {
  const json = JSON.stringify(args.offer);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  return `${args.appBaseUrl.replace(/\/$/, "")}/#offer=${encoded}`;
}

function getPrimaryLanIp(): string | null {
  const override = process.env.PASEO_PRIMARY_LAN_IP?.trim();
  if (override) return override;

  const nets = os.networkInterfaces();
  const names = Object.keys(nets).sort();

  for (const name of names) {
    const addrs = nets[name] ?? [];
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return null;
}

function dedupePreserveOrder(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
