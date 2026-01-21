import os from "node:os";
import { webcrypto } from "node:crypto";
import { z } from "zod";

export const ConnectionOfferV1Schema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  endpoints: z.array(z.string().min(1)).min(1),
  daemonPublicKeyB64: z.string().min(1),
});

export type ConnectionOfferV1 = z.infer<typeof ConnectionOfferV1Schema>;

type BuildOfferEndpointsArgs = {
  listenHost: string;
  port: number;
  relayEnabled: boolean;
  relayEndpoint: string;
};

export function buildOfferEndpoints({
  listenHost,
  port,
  relayEnabled,
  relayEndpoint,
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

  if (relayEnabled) {
    endpoints.push(relayEndpoint);
  }

  return dedupePreserveOrder(endpoints);
}

export async function createConnectionOfferV1(args: {
  sessionId: string;
  endpoints: string[];
}): Promise<ConnectionOfferV1> {
  const daemonPublicKeyB64 = await generateDaemonPublicKeyB64();

  return ConnectionOfferV1Schema.parse({
    v: 1,
    sessionId: args.sessionId,
    endpoints: args.endpoints,
    daemonPublicKeyB64,
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

async function generateDaemonPublicKeyB64(): Promise<string> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  const raw = await webcrypto.subtle.exportKey("raw", keyPair.publicKey);
  return Buffer.from(new Uint8Array(raw)).toString("base64");
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
