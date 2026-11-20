import { describe, expect, it } from "vitest";
import { buildDirectConnectionUri, normalizeDirectConnectionHost } from "./direct-connection-host";

const labels = {
  hostRequired: "host required",
  invalidPort: "invalid port",
};

function buildUri(host: string, port = "6767"): string {
  return buildDirectConnectionUri({ host, port, useTls: false, password: "" }, labels);
}

describe("normalizeDirectConnectionHost", () => {
  it.each([
    ["100.66.69.36", { host: "100.66.69.36", port: null, isIpv6: false }],
    ["  100.66.69.36  ", { host: "100.66.69.36", port: null, isIpv6: false }],
    ["100.66.69.36:6767", { host: "100.66.69.36", port: "6767", isIpv6: false }],
    ["tcp://100.66.69.36:6767", { host: "100.66.69.36", port: "6767", isIpv6: false }],
    ["http://100.66.69.36:6767/path?x=1#y", { host: "100.66.69.36", port: "6767", isIpv6: false }],
    ["HTTPS://example.test", { host: "example.test", port: null, isIpv6: false }],
    ["my-host.local:7000", { host: "my-host.local", port: "7000", isIpv6: false }],
    ["[::1]", { host: "::1", port: null, isIpv6: true }],
    ["[::1]:7000", { host: "::1", port: "7000", isIpv6: true }],
    ["::1", { host: "::1", port: null, isIpv6: true }],
    ["fe80::1", { host: "fe80::1", port: null, isIpv6: true }],
    ["", { host: "", port: null, isIpv6: false }],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeDirectConnectionHost(input)).toEqual(expected);
  });
});

describe("buildDirectConnectionUri", () => {
  it.each([
    ["100.66.69.36", "tcp://100.66.69.36:6767"],
    ["100.66.69.36:6767", "tcp://100.66.69.36:6767"],
    ["tcp://100.66.69.36:6767", "tcp://100.66.69.36:6767"],
    ["http://100.66.69.36:6767/path?x", "tcp://100.66.69.36:6767"],
    ["my-host.local:6767", "tcp://my-host.local:6767"],
    ["[::1]", "tcp://[::1]:6767"],
    ["[::1]:7000", "tcp://[::1]:7000"],
    ["::1", "tcp://[::1]:6767"],
    ["fe80::1", "tcp://[fe80::1]:6767"],
  ])("builds a tcp URI from host %j", (host, expected) => {
    expect(buildUri(host)).toBe(expected);
  });

  it("lets a port typed in the host field override the port field", () => {
    expect(buildUri("100.66.69.36:7000", "6767")).toBe("tcp://100.66.69.36:7000");
  });

  it("keeps TLS and password settings", () => {
    expect(
      buildDirectConnectionUri(
        { host: "tcp://example.test:443", port: "6767", useTls: true, password: "secret" },
        labels,
      ),
    ).toBe("tcp://example.test:443?ssl=true&password=secret");
  });

  it.each(["", "   ", "tcp://", "http:///path"])("requires a host for %j", (host) => {
    expect(() => buildUri(host)).toThrow("host required");
  });

  it("rejects an invalid port", () => {
    expect(() => buildUri("100.66.69.36", "70000")).toThrow("invalid port");
    expect(() => buildUri("100.66.69.36:0")).toThrow("invalid port");
  });
});
