/**
 * The daemon password travels as a WebSocket subprotocol because the browser
 * `WebSocket` constructor exposes no way to set request headers.
 *
 * Subprotocol values are HTTP tokens (RFC 6455 §4.1 -> RFC 7230 `tchar`), so a
 * password containing `@`, `/`, `=`, `:`, a space or any non-ASCII character
 * cannot be sent verbatim: the constructor throws a `SyntaxError` before any
 * connection is attempted, and the daemon never learns a client tried. Since
 * the daemon accepts those passwords when they are set, the constraint is
 * invisible until an unrelated client fails.
 *
 * Hex sidesteps the token character set entirely. It is preferred over base64url
 * here because it has a single canonical spelling per input — no padding or
 * alphabet variants to validate against on the receiving end — and encodes with
 * nothing but `TextEncoder`, which browsers, Node and Hermes all provide.
 *
 * Decoding is strict in both directions of that promise: malformed UTF-8 is
 * rejected rather than replaced, so one password never has two spellings.
 */

export const WS_BEARER_PREFIX = "paseo.bearer.";
export const WS_BEARER_HEX_PREFIX = "paseo.bearer-hex.";

const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
const HEX_PATTERN = /^(?:[0-9a-f]{2})+$/;

/**
 * Subprotocols advertising `password`, most preferred first.
 *
 * The verbatim form is still offered whenever it is a legal token so that a
 * client can reach a daemon predating the hex scheme; a password that is not a
 * legal token is only offered as hex, which such a daemon rejects the same way
 * it does today.
 */
export function buildBearerSubprotocols(password: string): string[] {
  const protocols = [`${WS_BEARER_HEX_PREFIX}${encodeHex(password)}`];
  if (HTTP_TOKEN_PATTERN.test(password)) {
    protocols.push(`${WS_BEARER_PREFIX}${password}`);
  }
  return protocols;
}

export function extractBearerToken(protocol: string): string | null {
  if (protocol.startsWith(WS_BEARER_HEX_PREFIX)) {
    return decodeHex(protocol.slice(WS_BEARER_HEX_PREFIX.length));
  }
  if (protocol.startsWith(WS_BEARER_PREFIX)) {
    return protocol.slice(WS_BEARER_PREFIX.length);
  }
  return null;
}

function encodeHex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function decodeHex(value: string): string | null {
  if (!HEX_PATTERN.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    // A lenient decoder maps every malformed sequence onto U+FFFD, so distinct
    // peer-supplied bytes would authenticate a password containing it.
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}
