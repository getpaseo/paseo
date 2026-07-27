import { describe, expect, it } from "vitest";
import { normalizeDaemonListenEndpoint } from "./daemon-listen-endpoint";

describe("normalizeDaemonListenEndpoint", () => {
  it("adds the TLS default port when the Host header omits it", () => {
    expect(normalizeDaemonListenEndpoint("5.78.184.144.nip.io", true)).toBe(
      "5.78.184.144.nip.io:443",
    );
  });

  it("keeps an explicit port", () => {
    expect(normalizeDaemonListenEndpoint("5.78.184.144:6767", false)).toBe("5.78.184.144:6767");
  });

  it("defaults localhost without a port to 6767", () => {
    expect(normalizeDaemonListenEndpoint("localhost", false)).toBe("localhost:6767");
  });
});
