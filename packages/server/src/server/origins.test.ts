import { describe, expect, it } from "vitest";
import { isOriginAllowed } from "./origins.js";

describe("isOriginAllowed", () => {
  it("matches exact origins and the * wildcard", () => {
    expect(isOriginAllowed("https://app.paseo.sh", ["https://app.paseo.sh"])).toBe(true);
    expect(isOriginAllowed("https://app.paseo.sh", ["https://other.paseo.sh"])).toBe(false);
    expect(isOriginAllowed("https://anything.test", ["*"])).toBe(true);
    expect(isOriginAllowed("https://anything.test", [])).toBe(false);
  });

  it("keeps an exact origin bound to its port", () => {
    expect(isOriginAllowed("http://localhost:8081", ["http://localhost:8081"])).toBe(true);
    expect(isOriginAllowed("http://localhost:8082", ["http://localhost:8081"])).toBe(false);
    expect(isOriginAllowed("https://app.paseo.sh:8443", ["https://app.paseo.sh"])).toBe(false);
  });

  it("matches a bare host on any scheme without an explicit port", () => {
    expect(isOriginAllowed("https://example.com", ["example.com"])).toBe(true);
    expect(isOriginAllowed("http://example.com", ["example.com"])).toBe(true);
    expect(isOriginAllowed("https://example.com:8443", ["example.com"])).toBe(false);
    expect(isOriginAllowed("https://foo.example.com", ["example.com"])).toBe(false);
  });

  it("matches subdomains with a leading dot", () => {
    expect(isOriginAllowed("https://example.com", [".example.com"])).toBe(true);
    expect(isOriginAllowed("https://foo.bar.example.com", [".example.com"])).toBe(true);
    expect(isOriginAllowed("https://notexample.com", [".example.com"])).toBe(false);
  });

  it("matches any port with a trailing colon", () => {
    expect(isOriginAllowed("https://foo.example.com:8443", [".example.com:"])).toBe(true);
    expect(isOriginAllowed("https://example.com", [".example.com:"])).toBe(true);
    expect(isOriginAllowed("http://example.com:3000", ["example.com:"])).toBe(true);
  });

  it("matches an explicit port, resolving the scheme default", () => {
    expect(isOriginAllowed("https://example.com:8443", ["example.com:8443"])).toBe(true);
    expect(isOriginAllowed("https://example.com", ["example.com:8443"])).toBe(false);
    expect(isOriginAllowed("https://example.com", ["example.com:443"])).toBe(true);
    expect(isOriginAllowed("http://example.com", ["example.com:443"])).toBe(false);
  });

  it("restricts the scheme when the entry names one", () => {
    expect(isOriginAllowed("https://foo.example.com", ["https://.example.com"])).toBe(true);
    expect(isOriginAllowed("http://foo.example.com", ["https://.example.com"])).toBe(false);
    expect(isOriginAllowed("https://foo.example.com:8443", ["https://.example.com:"])).toBe(true);
  });

  it("matches custom schemes and IPv6 hosts", () => {
    expect(isOriginAllowed("paseo://app", ["paseo://app"])).toBe(true);
    expect(isOriginAllowed("paseo://app", ["app"])).toBe(true);
    expect(isOriginAllowed("http://[::1]:8080", ["[::1]:"])).toBe(true);
    expect(isOriginAllowed("http://[::1]:8080", ["[::1]:8080"])).toBe(true);
  });

  it("ignores entry case", () => {
    expect(isOriginAllowed("https://example.com", ["Example.COM"])).toBe(true);
  });

  it("does not let lookalike hosts through a subdomain entry", () => {
    for (const origin of [
      "https://evil-example.com",
      "https://example.com.evil",
      "https://example.com.",
      "https://example.com.evil.test",
    ]) {
      expect(isOriginAllowed(origin, [".example.com", ".example.com:"])).toBe(false);
    }
  });

  it("only evaluates canonical serialized origins against patterns", () => {
    const entries = ["https://app.paseo.sh", ".paseo.sh:"];
    for (const origin of [
      "https://app.paseo.sh/attacker",
      "https://app.paseo.sh?x",
      "https://app.paseo.sh#x",
      "https:app.paseo.sh",
      "https://user@app.paseo.sh",
      "https://app.paseo.sh:443",
      "https://APP.paseo.sh",
      " https://app.paseo.sh",
      "https://app.paseo.sh/",
    ]) {
      expect(isOriginAllowed(origin, entries)).toBe(false);
    }
    expect(
      isOriginAllowed("https://app.paseo.sh/attacker", ["https://app.paseo.sh/attacker"]),
    ).toBe(true);
  });

  it("only matches unparseable origins exactly", () => {
    expect(isOriginAllowed("null", ["null"])).toBe(true);
    expect(isOriginAllowed("null", [".example.com", "*"])).toBe(true);
    expect(isOriginAllowed("null", [".example.com"])).toBe(false);
  });

  it("canonicalizes entry ports", () => {
    expect(isOriginAllowed("https://example.com:8443", ["example.com:08443"])).toBe(true);
  });

  it("skips malformed entries", () => {
    expect(isOriginAllowed("https://example.com", ["example.com:abc", "https://"])).toBe(false);
  });
});
