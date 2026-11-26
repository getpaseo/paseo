import { describe, expect, it } from "vitest";
import {
  describeActiveConnection,
  describeHostConnection,
  formatConnectionEndpoint,
  isTailscaleEndpoint,
} from "./connection-display";

describe("isTailscaleEndpoint", () => {
  it("recognizes MagicDNS .ts.net hostnames with or without ports", () => {
    expect(isTailscaleEndpoint("mac-mini.tail123.ts.net:6767")).toBe(true);
    expect(isTailscaleEndpoint("Mac-Mini.Tail123.TS.NET:443")).toBe(true);
    expect(isTailscaleEndpoint("devbox.tailnet.ts.net")).toBe(true);
    expect(isTailscaleEndpoint(".ts.net")).toBe(false);
  });

  it("recognizes Tailscale IPv4 CGNAT (100.64.0.0/10) and IPv6 ULA addresses", () => {
    expect(isTailscaleEndpoint("100.64.0.1:6767")).toBe(true);
    expect(isTailscaleEndpoint("100.100.42.9:6767")).toBe(true);
    expect(isTailscaleEndpoint("100.127.255.254:6767")).toBe(true);
    expect(isTailscaleEndpoint("100.63.255.255:6767")).toBe(false);
    expect(isTailscaleEndpoint("100.128.0.1:6767")).toBe(false);
    expect(isTailscaleEndpoint("[fd7a:115c:a1e0::1]:6767")).toBe(true);
  });

  it("does not misclassify LAN, localhost, or ordinary domains", () => {
    expect(isTailscaleEndpoint("localhost:6767")).toBe(false);
    expect(isTailscaleEndpoint("127.0.0.1:6767")).toBe(false);
    expect(isTailscaleEndpoint("192.168.1.25:6767")).toBe(false);
    expect(isTailscaleEndpoint("relay.paseo.sh:443")).toBe(false);
    expect(isTailscaleEndpoint("not-ts.net.example.com:6767")).toBe(false);
  });
});

describe("describeActiveConnection", () => {
  it("describes local socket and pipe connections without exposing paths", () => {
    expect(
      describeActiveConnection({
        type: "directSocket",
        endpoint: "/tmp/paseo.sock",
        display: "socket",
      }),
    ).toEqual({ kind: "local" });
    expect(
      describeActiveConnection({
        type: "directPipe",
        endpoint: "\\\\.\\pipe\\paseo",
        display: "pipe",
      }),
    ).toEqual({ kind: "local" });
  });

  it("describes loopback TCP on the local host as local, and remote loopback as direct", () => {
    const loopback = {
      type: "directTcp",
      endpoint: "localhost:6767",
      display: "localhost:6767",
    } as const;
    expect(describeActiveConnection(loopback, { isLocalHost: true })).toEqual({ kind: "local" });
    expect(describeActiveConnection(loopback, { isLocalHost: false })).toEqual({
      kind: "direct",
      endpoint: "localhost:6767",
    });
  });

  it("strips standard web ports on relay, tailscale, and direct connections", () => {
    expect(
      describeActiveConnection({ type: "relay", endpoint: "relay.paseo.sh:443", display: "relay" }),
    ).toEqual({ kind: "relay", endpoint: "relay.paseo.sh" });
    expect(
      describeActiveConnection({
        type: "directTcp",
        endpoint: "mac-mini.tail123.ts.net:6767",
        display: "mac-mini.tail123.ts.net:6767",
      }),
    ).toEqual({ kind: "tailscale", endpoint: "mac-mini.tail123.ts.net:6767" });
    expect(
      describeActiveConnection({
        type: "directTcp",
        endpoint: "devbox.example.com:443",
        display: "devbox.example.com:443",
      }),
    ).toEqual({ kind: "direct", endpoint: "devbox.example.com" });
  });

  it("preserves SSH and routed targets", () => {
    expect(
      describeActiveConnection({
        type: "remoteSsh",
        endpoint: "mo@workstation",
        display: "mo@workstation",
      }),
    ).toEqual({ kind: "ssh", endpoint: "mo@workstation" });
    expect(
      describeActiveConnection({
        type: "routed",
        endpoint: "srv_origin",
        display: "via srv_origin",
      }),
    ).toEqual({ kind: "routed", endpoint: "srv_origin" });
  });

  it("strips default HTTP/HTTPS ports only", () => {
    expect(formatConnectionEndpoint("relay.paseo.sh:443")).toBe("relay.paseo.sh");
    expect(formatConnectionEndpoint("example.com:80")).toBe("example.com");
    expect(formatConnectionEndpoint("127.0.0.1:6767")).toBe("127.0.0.1:6767");
  });

  it("describes configured host connections before an active connection is online", () => {
    expect(
      describeHostConnection({
        id: "direct:mac-mini.tail123.ts.net:6767",
        type: "directTcp",
        endpoint: "mac-mini.tail123.ts.net:6767",
      }),
    ).toEqual({ kind: "tailscale", endpoint: "mac-mini.tail123.ts.net:6767" });
    expect(
      describeHostConnection({
        id: "relay:wss:relay.paseo.sh:443",
        type: "relay",
        relayEndpoint: "relay.paseo.sh:443",
        useTls: true,
        daemonPublicKeyB64: "key",
      }),
    ).toEqual({ kind: "relay", endpoint: "relay.paseo.sh" });
    expect(
      describeHostConnection({
        id: "ssh:mo%40workstation::",
        type: "remoteSsh",
        host: "mo@workstation",
      }),
    ).toEqual({ kind: "ssh", endpoint: "mo@workstation" });
  });
});
