import { describe, expect, it } from "vitest";
import type { HostConnection } from "@/types/host-connection";
import {
  classifyHostBrowserRouting,
  extractBrowserProxyTarget,
  isLoopbackBrowserUrl,
  isLoopbackHost,
  shouldOpenUrlInProxiedWorkspaceBrowser,
} from "./classify";

describe("loopback URL classification", () => {
  it("recognizes localhost, *.localhost, 127.x, and ::1 hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("web.localhost")).toBe(true);
    expect(isLoopbackHost("api.v2.localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);

    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("localhost.example.com")).toBe(false);
    expect(isLoopbackHost("192.168.1.5")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });

  it("matches only http/https loopback URLs", () => {
    expect(isLoopbackBrowserUrl("http://localhost:5173")).toBe(true);
    expect(isLoopbackBrowserUrl("https://app.localhost:6767/dashboard")).toBe(true);
    expect(isLoopbackBrowserUrl("http://127.0.0.1:3000/api")).toBe(true);
    expect(isLoopbackBrowserUrl("http://[::1]:8080")).toBe(true);

    expect(isLoopbackBrowserUrl("https://github.com/getpaseo/paseo")).toBe(false);
    expect(isLoopbackBrowserUrl("http://10.0.0.5:3000")).toBe(false);
    expect(isLoopbackBrowserUrl("ws://localhost:3000")).toBe(false);
    expect(isLoopbackBrowserUrl("not-a-url")).toBe(false);
  });
});

describe("classifyHostBrowserRouting", () => {
  const remoteTcp: HostConnection = {
    id: "direct:10.0.0.5:6767",
    type: "directTcp",
    endpoint: "10.0.0.5:6767",
  };
  const localTcp: HostConnection = {
    id: "direct:127.0.0.1:6767",
    type: "directTcp",
    endpoint: "127.0.0.1:6767",
  };
  const localSocket: HostConnection = {
    id: "socket:/tmp/paseo.sock",
    type: "directSocket",
    path: "/tmp/paseo.sock",
  };
  const remoteSsh: HostConnection = {
    id: "ssh:devbox",
    type: "remoteSsh",
    host: "devbox",
    sshPort: 2222,
    daemonPort: 6767,
  };
  const relayConn: HostConnection = {
    id: "relay:relay.paseo.sh",
    type: "relay",
    relayEndpoint: "relay.paseo.sh",
    useTls: true,
    daemonPublicKeyB64: "AAAA",
    minimumSecurityMode: "protected",
  };
  const routedConn: HostConnection = {
    id: "routed:origin-1",
    type: "routed",
    originServerId: "origin-1",
  };

  it("classifies local socket, pipe, and loopback directTcp connections as local", () => {
    expect(
      classifyHostBrowserRouting({
        serverId: "local-1",
        connections: [localSocket],
        activeConnection: { type: "directSocket", endpoint: "/tmp/paseo.sock", display: "socket" },
        activeConnectionId: localSocket.id,
        connectionStatus: "online",
        supportsNetworkTunnel: true,
      }),
    ).toEqual({ kind: "local" });

    expect(
      classifyHostBrowserRouting({
        serverId: "local-2",
        connections: [localTcp],
        activeConnection: {
          type: "directTcp",
          endpoint: "127.0.0.1:6767",
          display: "127.0.0.1:6767",
        },
        activeConnectionId: localTcp.id,
        connectionStatus: "online",
        supportsNetworkTunnel: true,
      }),
    ).toEqual({ kind: "local" });
  });

  it("classifies remote directTcp, SSH, and relay hosts with networkTunnel as supported", () => {
    expect(
      classifyHostBrowserRouting({
        serverId: "remote-tcp",
        connections: [remoteTcp],
        activeConnection: {
          type: "directTcp",
          endpoint: "10.0.0.5:6767",
          display: "10.0.0.5:6767",
        },
        activeConnectionId: remoteTcp.id,
        connectionStatus: "online",
        supportsNetworkTunnel: true,
      }),
    ).toEqual({
      kind: "remote",
      support: "supported",
      target: { type: "directTcp", endpoint: "10.0.0.5:6767" },
    });

    expect(extractBrowserProxyTarget("remote-ssh", remoteSsh)).toEqual({
      type: "remoteSsh",
      host: "devbox",
      sshPort: 2222,
      daemonPort: 6767,
    });

    expect(extractBrowserProxyTarget("remote-relay", relayConn)).toEqual({
      type: "relay",
      serverId: "remote-relay",
      relayEndpoint: "relay.paseo.sh",
      useTls: true,
      daemonPublicKeyB64: "AAAA",
      minimumSecurityMode: "protected",
    });
  });

  it("fails closed for old daemons, routed hosts, connecting hosts, and offline remote hosts", () => {
    expect(
      classifyHostBrowserRouting({
        serverId: "old-daemon",
        connections: [remoteTcp],
        activeConnection: {
          type: "directTcp",
          endpoint: "10.0.0.5:6767",
          display: "10.0.0.5:6767",
        },
        activeConnectionId: remoteTcp.id,
        connectionStatus: "online",
        supportsNetworkTunnel: false,
      }),
    ).toEqual({ kind: "remote", support: "daemon_update_required" });

    expect(
      classifyHostBrowserRouting({
        serverId: "routed-host",
        connections: [routedConn],
        activeConnection: { type: "routed", endpoint: "origin-1", display: "via origin-1" },
        activeConnectionId: routedConn.id,
        connectionStatus: "online",
        supportsNetworkTunnel: true,
      }),
    ).toEqual({ kind: "remote", support: "routed_unsupported" });

    expect(
      classifyHostBrowserRouting({
        serverId: "offline-remote",
        connections: [remoteSsh],
        activeConnection: null,
        activeConnectionId: null,
        connectionStatus: "offline",
        supportsNetworkTunnel: null,
      }),
    ).toEqual({ kind: "remote", support: "host_offline" });

    expect(
      classifyHostBrowserRouting({
        serverId: "connecting-remote",
        connections: [relayConn],
        activeConnection: null,
        activeConnectionId: null,
        connectionStatus: "connecting",
        supportsNetworkTunnel: null,
      }),
    ).toEqual({ kind: "remote", support: "host_connecting" });
  });

  it("routes only loopback URLs on supported remote hosts in Electron to a proxied browser tab", () => {
    const supportedRemote = {
      kind: "remote" as const,
      support: "supported" as const,
      target: { type: "directTcp" as const, endpoint: "10.0.0.5:6767" },
    };
    const oldRemote = { kind: "remote" as const, support: "daemon_update_required" as const };
    const local = { kind: "local" as const };

    expect(
      shouldOpenUrlInProxiedWorkspaceBrowser({
        isElectron: true,
        url: "http://localhost:5173",
        routing: supportedRemote,
      }),
    ).toBe(true);
    expect(
      shouldOpenUrlInProxiedWorkspaceBrowser({
        isElectron: true,
        url: "https://github.com/getpaseo/paseo",
        routing: supportedRemote,
      }),
    ).toBe(false);
    expect(
      shouldOpenUrlInProxiedWorkspaceBrowser({
        isElectron: true,
        url: "http://localhost:5173",
        routing: oldRemote,
      }),
    ).toBe(false);
    expect(
      shouldOpenUrlInProxiedWorkspaceBrowser({
        isElectron: true,
        url: "http://localhost:5173",
        routing: local,
      }),
    ).toBe(false);
    expect(
      shouldOpenUrlInProxiedWorkspaceBrowser({
        isElectron: false,
        url: "http://localhost:5173",
        routing: supportedRemote,
      }),
    ).toBe(false);
  });
});
