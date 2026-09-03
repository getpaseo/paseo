const LEGACY_BEARER_PREFIX = "paseo.bearer.";
const ENCODED_BEARER_PREFIX = "paseo.bearer64.";
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BASE64URL_PATTERN = /^[0-9A-Za-z_-]+$/;

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): string | null {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    return null;
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  try {
    const binary = globalThis.atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function encodeWebSocketBearerProtocol(password: string): string {
  // COMPAT(websocketBearer64): added in v0.2.4; keep token-safe passwords on the
  // legacy form until the minimum supported daemon is >= v0.2.4 (target 2027-01-28).
  if (HTTP_TOKEN_PATTERN.test(password)) {
    return `${LEGACY_BEARER_PREFIX}${password}`;
  }
  return `${ENCODED_BEARER_PREFIX}${encodeBase64Url(password)}`;
}

export function decodeWebSocketBearerProtocol(protocol: string): string | null {
  if (protocol.startsWith(LEGACY_BEARER_PREFIX)) {
    const password = protocol.slice(LEGACY_BEARER_PREFIX.length);
    return password.length > 0 ? password : null;
  }
  if (!protocol.startsWith(ENCODED_BEARER_PREFIX)) {
    return null;
  }
  return decodeBase64Url(protocol.slice(ENCODED_BEARER_PREFIX.length));
}
