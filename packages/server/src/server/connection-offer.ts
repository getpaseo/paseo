import os from "node:os";

import {
  ConnectionOfferV2Schema,
  type ConnectionOffer,
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

export async function createConnectionOfferV2(args: {
  serverId: string;
  daemonPublicKeyB64: string;
  relay: { endpoint: string };
}): Promise<ConnectionOffer> {
  return ConnectionOfferV2Schema.parse({
    v: 2,
    serverId: args.serverId,
    daemonPublicKeyB64: args.daemonPublicKeyB64,
    relay: args.relay,
  });
}

export function encodeOfferToFragmentUrl(args: {
  offer: ConnectionOffer;
  appBaseUrl: string;
}): string {
  const json = JSON.stringify(args.offer);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  return `${args.appBaseUrl.replace(/\/$/, "")}/#offer=${encoded}`;
}

function getPrimaryLanIp(): string | null {
  const override = process.env.JUNCTION_PRIMARY_LAN_IP?.trim();
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
