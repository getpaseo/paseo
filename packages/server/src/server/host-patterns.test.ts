import { describe, expect, it } from "vitest";
import { parseHostAuthority, parseHostPattern } from "./host-patterns.js";

describe("parseHostPattern", () => {
  it("splits scheme, subdomain marker, host, and port", () => {
    expect(parseHostPattern("HTTPS://.Example.com:8443", { unspecifiedPort: "any" })).toEqual({
      scheme: "https",
      host: "example.com",
      matchesSubdomains: true,
      port: { kind: "exact", port: "8443" },
    });
  });

  it("applies the caller's rule when no port is written", () => {
    expect(parseHostPattern("example.com", { unspecifiedPort: "any" })?.port).toEqual({
      kind: "any",
    });
    expect(parseHostPattern("example.com", { unspecifiedPort: "implicit" })?.port).toEqual({
      kind: "implicit",
    });
  });

  it("reads a trailing colon as any port", () => {
    expect(parseHostPattern(".example.com:", { unspecifiedPort: "implicit" })?.port).toEqual({
      kind: "any",
    });
  });

  it("parses bracketed IPv6 hosts and canonicalizes the port", () => {
    expect(parseHostPattern("[::1]:6767", { unspecifiedPort: "any" })).toEqual({
      scheme: null,
      host: "::1",
      matchesSubdomains: false,
      port: { kind: "exact", port: "6767" },
    });
    expect(parseHostPattern("example.com:08443", { unspecifiedPort: "any" })?.port).toEqual({
      kind: "exact",
      port: "8443",
    });
  });

  it("rejects empty hosts, empty schemes, bad ports, and unbracketed IPv6", () => {
    const rejected = [
      "",
      ".",
      ":",
      "://example.com",
      "example.com:abc",
      "example.com:65536",
      "[::1",
      "[::1]x",
      "[example.com]:6767",
      "::1",
    ];
    for (const raw of rejected) {
      expect(parseHostPattern(raw, { unspecifiedPort: "any" })).toBeNull();
    }
  });
});

describe("parseHostAuthority", () => {
  it("lowercases the hostname and keeps an explicit port", () => {
    expect(parseHostAuthority("Example.com:6767")).toEqual({
      hostname: "example.com",
      port: "6767",
    });
    expect(parseHostAuthority("example.com")).toEqual({ hostname: "example.com", port: null });
    expect(parseHostAuthority("[::1]:6767")).toEqual({ hostname: "::1", port: "6767" });
    expect(parseHostAuthority("example.com:06767")).toEqual({
      hostname: "example.com",
      port: "6767",
    });
  });

  it("rejects empty, non-numeric, or out-of-range ports", () => {
    expect(parseHostAuthority("example.com:")).toBeNull();
    expect(parseHostAuthority("example.com:abc")).toBeNull();
    expect(parseHostAuthority("example.com:65536")).toBeNull();
    expect(parseHostAuthority("")).toBeNull();
  });

  it("rejects brackets around anything but an IPv6 literal, and bare IPv6", () => {
    expect(parseHostAuthority("[example.com]:6767")).toBeNull();
    expect(parseHostAuthority("::1")).toBeNull();
  });
});
