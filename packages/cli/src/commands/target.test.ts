import { describe, expect, it } from "vitest";
import { normalizeDefaultDaemonTarget } from "./target.js";

function pairingOfferUrl(): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 2,
      serverId: "always-on-daemon",
      daemonPublicKeyB64: "public-key",
      relay: { endpoint: "relay.paseo.sh:443", useTls: true },
    }),
    "utf8",
  ).toString("base64url");
  return `https://app.paseo.sh/#offer=${payload}`;
}

describe("default CLI daemon target", () => {
  it("accepts the same relay pairing offer used by mobile", () => {
    const offer = pairingOfferUrl();
    expect(normalizeDefaultDaemonTarget(offer)).toBe(offer);
  });

  it("normalizes direct and local socket targets", () => {
    expect(normalizeDefaultDaemonTarget("  m4-mini:6767 ")).toBe("m4-mini:6767");
    expect(normalizeDefaultDaemonTarget("/tmp/paseo.sock")).toBe("unix:///tmp/paseo.sock");
  });

  it("rejects ordinary web URLs and malformed pairing offers", () => {
    expect(() => normalizeDefaultDaemonTarget("https://example.com")).toThrow(
      "Invalid daemon target",
    );
    expect(() => normalizeDefaultDaemonTarget("https://app.paseo.sh/#offer=broken")).toThrow(
      "Invalid pairing offer URL",
    );
    expect(() => normalizeDefaultDaemonTarget("m4-mini:70000")).toThrow(
      "port must be between 1 and 65535",
    );
    expect(() => normalizeDefaultDaemonTarget("unix://")).toThrow("missing socket path");
  });
});
