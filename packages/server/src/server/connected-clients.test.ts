import { describe, expect, it } from "vitest";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { buildConnectedClientsSnapshot, type ConnectedClientRecord } from "./connected-clients.js";

function makeRecord(overrides: Partial<ConnectedClientRecord> = {}): ConnectedClientRecord {
  return {
    sessionId: "sess_1",
    clientId: "cid_1",
    principalId: "owner",
    sourceId: "owner",
    clientType: "mobile",
    clientInfo: { name: "Mo's MacBook Pro", platform: "macos", kind: "desktop" },
    appVersion: "0.18.1",
    permissions: OWNER_PERMISSIONS,
    principalPermissions: OWNER_PERMISSIONS,
    connectedAt: "2026-11-28T10:00:00.000Z",
    socketCount: 1,
    isCurrentSession: false,
    isEphemeralPlugin: false,
    pluginId: null,
    isRouted: false,
    identity: { transport: "direct", peer: "local_ipc" },
    hubOrigin: null,
    routedChildren: [],
    hasHostLink: false,
    ...overrides,
  };
}

describe("buildConnectedClientsSnapshot", () => {
  it("sorts current session first, classifies transports, and tracks attenuated scopes", () => {
    const snapshot = buildConnectedClientsSnapshot(
      [
        makeRecord({
          sessionId: "sess_hub",
          clientId: "hub:dmn_1",
          principalId: "hub:dmn_1",
          clientType: "hub",
          clientInfo: null,
          appVersion: null,
          permissions: ["hub.execute", "workspace.read"],
          principalPermissions: ["hub.execute", "workspace.read"],
          identity: { transport: "hub", peer: "external", hubDaemonId: "dmn_1" },
          hubOrigin: "https://hub.paseo.sh",
          connectedAt: "2026-11-25T10:00:00.000Z",
        }),
        makeRecord({
          sessionId: "sess_phone",
          clientId: "cid_phone",
          clientInfo: { name: "Mo's iPhone", platform: "ios", kind: "mobile" },
          permissions: ["daemon.read", "workspace.read"],
          principalPermissions: OWNER_PERMISSIONS,
          identity: {
            transport: "direct",
            peer: "external",
            localEndpoint: "100.87.1.2:6767",
          },
          connectedAt: "2026-11-28T11:00:00.000Z",
        }),
        makeRecord({
          sessionId: "sess_me",
          clientId: "cid_me",
          isCurrentSession: true,
          connectedAt: "2026-11-28T12:00:00.000Z",
        }),
      ],
      {
        isTailscaleEndpoint: (endpoint) => endpoint === "100.87.1.2:6767",
      },
    );

    expect(snapshot.clients.map((entry) => entry.sessionId)).toEqual([
      "sess_me",
      "sess_hub",
      "sess_phone",
    ]);
    expect(snapshot.clients[0]).toMatchObject({
      isCurrentSession: true,
      kind: "desktop",
      transport: "local_ipc",
      attenuated: false,
    });
    expect(snapshot.clients[1]).toMatchObject({
      kind: "hub",
      name: "Paseo Hub",
      transport: "hub",
      hubOrigin: "https://hub.paseo.sh",
      permissions: ["hub.execute", "workspace.read"],
      attenuated: false,
    });
    expect(snapshot.clients[2]).toMatchObject({
      kind: "mobile",
      name: "Mo's iPhone",
      transport: "tailscale",
      permissions: ["daemon.read", "workspace.read"],
      attenuated: true,
    });
  });

  it("hides ephemeral plugin and cli/mcp sessions by default unless includeInternal is true", () => {
    const records = [
      makeRecord({ sessionId: "sess_app", isCurrentSession: true }),
      makeRecord({
        sessionId: "sess_cli",
        clientId: "cli_1",
        clientType: "cli",
        clientInfo: null,
      }),
      makeRecord({
        sessionId: "sess_plugin",
        clientId: "plugin:foo",
        clientType: "cli",
        clientInfo: null,
        isEphemeralPlugin: true,
        pluginId: "foo",
      }),
    ];

    expect(buildConnectedClientsSnapshot(records).clients.map((c) => c.sessionId)).toEqual([
      "sess_app",
    ]);
    expect(
      buildConnectedClientsSnapshot(records, { includeInternal: true }).clients.map(
        (c) => c.sessionId,
      ),
    ).toEqual(["sess_app", "sess_cli", "sess_plugin"]);
  });

  it("separates inbound daemons and nests their active routed sessions", () => {
    const routedChild = makeRecord({
      sessionId: "sess_routed",
      clientId: "link-abc",
      sourceId: "route:owner:srv_peer:owner",
      clientInfo: { name: "Mo's iPhone", platform: "ios", kind: "mobile" },
      permissions: ["daemon.read", "workspace.read"],
      principalPermissions: ["daemon.read", "workspace.read", "workspace.write"],
      isRouted: true,
    });

    const peerDaemon = makeRecord({
      sessionId: "sess_peer",
      clientId: "host-link-srv_peer-hst_123",
      clientType: "cli",
      clientInfo: { name: "mac-studio", kind: "daemon", peerServerId: "srv_peer" },
      permissions: ["daemon.read", "workspace.read", "workspace.write"],
      principalPermissions: ["daemon.read", "workspace.read", "workspace.write"],
      identity: { transport: "relay", peer: "external", securityMode: "protected" },
      hasHostLink: true,
      routedChildren: [routedChild],
    });

    const snapshot = buildConnectedClientsSnapshot([peerDaemon, routedChild]);
    expect(snapshot.clients).toEqual([]);
    expect(snapshot.inboundDaemons).toEqual([
      {
        sessionId: "sess_peer",
        peerServerId: "srv_peer",
        name: "mac-studio",
        appVersion: "0.18.1",
        principalId: "owner",
        transport: "relay",
        securityMode: "protected",
        permissions: ["daemon.read", "workspace.read", "workspace.write"],
        connectedAt: "2026-11-28T10:00:00.000Z",
        socketCount: 1,
        routedSessions: [
          {
            sessionId: "sess_routed",
            sourceId: "route:owner:srv_peer:owner",
            name: "Mo's iPhone",
            kind: "mobile",
            appVersion: "0.18.1",
            permissions: ["daemon.read", "workspace.read"],
            attenuated: true,
            connectedAt: "2026-11-28T10:00:00.000Z",
          },
        ],
      },
    ]);
  });
});
