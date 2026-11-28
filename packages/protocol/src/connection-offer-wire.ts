/**
 * Zero-Zod wire parser for relay-only pairing offers.
 *
 * `serverId` is a stable daemon identifier scoped to `PASEO_HOME`, and is also
 * used as the relay session identifier.
 */
export interface ConnectionOfferV2 {
  v: 2;
  serverId: string;
  daemonPublicKeyB64: string;
  relay: {
    endpoint: string;
    useTls?: boolean;
  };
  // COMPAT(relayProtectedSecurity): added in v0.13.0. Present when the daemon requires
  // protected endpoint security; clients pin it before their first handshake.
  minimumSecurityMode?: "protected";
}

export type ConnectionOffer = ConnectionOfferV2;

function decodeBase64UrlToUtf8(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = globalThis.atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function decodeOfferFragmentPayload(encoded: string): unknown {
  const json = decodeBase64UrlToUtf8(encoded);
  return JSON.parse(json) as unknown;
}

const OFFER_FRAGMENT_PREFIX = "#offer=";

function extractOfferFragmentEncoded(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const fragmentIndex = trimmed.indexOf(OFFER_FRAGMENT_PREFIX);
  if (fragmentIndex === -1) return null;
  const encoded = trimmed.slice(fragmentIndex + OFFER_FRAGMENT_PREFIX.length).trim();
  return encoded.length > 0 ? encoded : null;
}

export function parseConnectionOffer(payload: unknown): ConnectionOffer {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid connection offer payload");
  }
  const record = payload as Record<string, unknown>;
  if (record.v !== 2) {
    throw new Error("Unsupported connection offer version");
  }
  if (typeof record.serverId !== "string" || record.serverId.length === 0) {
    throw new Error("Invalid connection offer serverId");
  }
  if (typeof record.daemonPublicKeyB64 !== "string" || record.daemonPublicKeyB64.length === 0) {
    throw new Error("Invalid connection offer daemonPublicKeyB64");
  }
  const relay = record.relay;
  if (!relay || typeof relay !== "object" || Array.isArray(relay)) {
    throw new Error("Invalid connection offer relay");
  }
  const relayRecord = relay as Record<string, unknown>;
  if (typeof relayRecord.endpoint !== "string" || relayRecord.endpoint.length === 0) {
    throw new Error("Invalid connection offer relay endpoint");
  }
  if (relayRecord.useTls !== undefined && typeof relayRecord.useTls !== "boolean") {
    throw new Error("Invalid connection offer relay useTls");
  }
  if (record.minimumSecurityMode !== undefined && record.minimumSecurityMode !== "protected") {
    throw new Error("Invalid connection offer minimumSecurityMode");
  }
  return {
    v: 2,
    serverId: record.serverId,
    daemonPublicKeyB64: record.daemonPublicKeyB64,
    relay: {
      endpoint: relayRecord.endpoint,
      ...(relayRecord.useTls !== undefined ? { useTls: relayRecord.useTls } : {}),
    },
    ...(record.minimumSecurityMode !== undefined
      ? { minimumSecurityMode: record.minimumSecurityMode }
      : {}),
  };
}

/**
 * Parse a pairing-offer URL of the form `https://app.paseo.sh/#offer=<base64url>`.
 *
 * Returns `null` if the input has no `#offer=` fragment. Throws if the fragment
 * exists but the payload is malformed or fails validation.
 */
export function parseConnectionOfferFromUrl(input: string): ConnectionOffer | null {
  const encoded = extractOfferFragmentEncoded(input);
  if (!encoded) return null;
  const payload = decodeOfferFragmentPayload(encoded);
  return parseConnectionOffer(payload);
}
