import { describe, expect, test } from "vitest";

import {
  buildBearerSubprotocols,
  extractBearerToken,
  WS_BEARER_HEX_PREFIX,
  WS_BEARER_PREFIX,
} from "./daemon-bearer.js";

// RFC 6455 §4.1 -> RFC 7230 `tchar`; the same set the WebSocket constructor enforces.
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;

// Every character the WebSocket constructor rejects inside a subprotocol.
const REJECTED_CHARACTERS = [
  "@",
  "/",
  "=",
  ":",
  ";",
  ",",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "<",
  ">",
  "\\",
  '"',
  " ",
];

describe("daemon bearer subprotocols", () => {
  test("encodes passwords the WebSocket constructor would reject", () => {
    for (const character of REJECTED_CHARACTERS) {
      const password = `corr${character}ct-horse`;
      const protocols = buildBearerSubprotocols(password);

      for (const protocol of protocols) {
        expect(protocol).toMatch(HTTP_TOKEN_PATTERN);
      }
      expect(protocols.map(extractBearerToken)).toContain(password);
    }
  });

  test("round-trips passwords with non-ASCII characters", () => {
    for (const password of ["sen#a-válida", "パスワード", "🔐-key"]) {
      const [hexProtocol] = buildBearerSubprotocols(password);

      expect(hexProtocol).toMatch(HTTP_TOKEN_PATTERN);
      expect(extractBearerToken(hexProtocol)).toBe(password);
    }
  });

  test("offers the verbatim form only when it is a legal token", () => {
    // `openssl rand -base64` output: `+` is a legal tchar, `/` and `=` are not.
    expect(buildBearerSubprotocols("aGVsbG8+d29ybGQ")).toEqual([
      `${WS_BEARER_HEX_PREFIX}614756736247382b64323979624751`,
      `${WS_BEARER_PREFIX}aGVsbG8+d29ybGQ`,
    ]);
    expect(buildBearerSubprotocols("has/slash")).toEqual([
      `${WS_BEARER_HEX_PREFIX}6861732f736c617368`,
    ]);
  });

  test("prefers the hex form so a current daemon never sees the password verbatim", () => {
    const [preferred] = buildBearerSubprotocols("token-safe");

    expect(preferred.startsWith(WS_BEARER_HEX_PREFIX)).toBe(true);
  });

  test("keeps reading the verbatim form, dots included", () => {
    expect(extractBearerToken("paseo.bearer.secret.with.dots")).toBe("secret.with.dots");
    expect(extractBearerToken("paseo.other.secret")).toBeNull();
    expect(extractBearerToken("paseo.bearer")).toBeNull();
  });

  test("rejects malformed hex instead of accepting a corrupted token", () => {
    expect(extractBearerToken(`${WS_BEARER_HEX_PREFIX}`)).toBeNull();
    expect(extractBearerToken(`${WS_BEARER_HEX_PREFIX}abc`)).toBeNull();
    expect(extractBearerToken(`${WS_BEARER_HEX_PREFIX}zz`)).toBeNull();
    // Uppercase is not the canonical spelling this scheme emits.
    expect(extractBearerToken(`${WS_BEARER_HEX_PREFIX}4a4b`)).toBe("JK");
    expect(extractBearerToken(`${WS_BEARER_HEX_PREFIX}4A4B`)).toBeNull();
  });

  test("rejects malformed UTF-8 instead of folding it onto U+FFFD", () => {
    // A lenient decoder maps each of these onto U+FFFD, which would let three
    // distinct peer-supplied values authenticate a password containing it.
    for (const malformed of ["ff", "fe", "c0"]) {
      expect(extractBearerToken(`${WS_BEARER_HEX_PREFIX}${malformed}`)).toBeNull();
    }

    // The character itself still round-trips through its own encoding.
    const [encoded] = buildBearerSubprotocols("\uFFFD");
    expect(encoded).toBe(`${WS_BEARER_HEX_PREFIX}efbfbd`);
    expect(extractBearerToken(encoded)).toBe("\uFFFD");
  });

  test("does not confuse a password that looks like the hex prefix", () => {
    // `paseo.bearer.` and `paseo.bearer-hex.` diverge at the separator, so a
    // verbatim password can never be read as an encoded one.
    const password = "-hex.4142";
    const protocols = buildBearerSubprotocols(password);

    expect(protocols).toContain(`${WS_BEARER_PREFIX}${password}`);
    expect(extractBearerToken(`${WS_BEARER_PREFIX}${password}`)).toBe(password);
  });
});
