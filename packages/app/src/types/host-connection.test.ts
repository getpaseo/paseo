import { describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import {
  normalizeStoredHostProfile,
  orderHostsLocalFirst,
  resolveActiveHostServerId,
  upsertHostConnectionInProfiles,
  type HostConnection,
  type HostProfile,
} from "./host-connection";

function makeHost(serverId: string): HostProfile {
  return {
    serverId,
    label: serverId,
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections: [],
    preferredConnectionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("orderHostsLocalFirst", () => {
  it("moves the local host to the first position", () => {
    const remote = makeHost("srv_remote");
    const local = makeHost("srv_local");
    const anotherRemote = makeHost("srv_another_remote");

    expect(orderHostsLocalFirst([remote, local, anotherRemote], "srv_local")).toEqual([
      local,
      remote,
      anotherRemote,
    ]);
  });

  it("preserves host order when the local host is missing", () => {
    const hosts = [makeHost("srv_remote"), makeHost("srv_another_remote")];

    expect(orderHostsLocalFirst(hosts, "srv_local")).toBe(hosts);
  });

  it("preserves host order when there is no local host", () => {
    const hosts = [makeHost("srv_remote"), makeHost("srv_another_remote")];

    expect(orderHostsLocalFirst(hosts, null)).toBe(hosts);
  });
});

describe("normalizeStoredHostProfile", () => {
  it("loads direct TCP connections stored before TLS and password fields existed", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_old",
      label: "Old Host",
      connections: [
        {
          id: "direct:127.0.0.1:6767",
          type: "directTcp",
          endpoint: "127.0.0.1:6767",
        },
      ],
      preferredConnectionId: "direct:127.0.0.1:6767",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(profile).not.toBeNull();
    expect(profile?.connections[0]).toEqual({
      id: "direct:localhost:6767",
      type: "directTcp",
      endpoint: "localhost:6767",
      useTls: false,
    });
    expect(profile?.connections[0]).not.toHaveProperty("password");
  });

  it("preserves legacy relay ids when TLS is absent", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_relay",
      connections: [
        {
          id: "relay:relay.example.com:80",
          type: "relay",
          relayEndpoint: "relay.example.com:80",
          daemonPublicKeyB64: "pubkey",
        },
      ],
    });

    expect(profile?.connections[0]).toEqual({
      id: "relay:relay.example.com:80",
      type: "relay",
      relayEndpoint: "relay.example.com:80",
      daemonPublicKeyB64: "pubkey",
    });
  });

  it("namespaces relay ids only when TLS is true", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_relay",
      connections: [
        {
          id: "relay:relay.example.com:443",
          type: "relay",
          relayEndpoint: "relay.example.com:443",
          useTls: true,
          daemonPublicKeyB64: "pubkey",
        },
      ],
    });

    expect(profile?.connections[0]).toEqual({
      id: "relay:wss:relay.example.com:443",
      type: "relay",
      relayEndpoint: "relay.example.com:443",
      useTls: true,
      daemonPublicKeyB64: "pubkey",
    });
  });

  it("gives a host stored before appearance existed the default appearance", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_old",
      connections: [
        { id: "socket:/tmp/paseo.sock", type: "directSocket", path: "/tmp/paseo.sock" },
      ],
    });

    expect(profile?.appearance).toEqual({ color: "none", badgeDisplay: null });
  });

  it("loads a stored appearance the user chose", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_new",
      appearance: { color: "teal", badgeDisplay: "icon" },
      connections: [
        { id: "socket:/tmp/paseo.sock", type: "directSocket", path: "/tmp/paseo.sock" },
      ],
    });

    expect(profile?.appearance).toEqual({ color: "teal", badgeDisplay: "icon" });
  });
});

describe("upsertHostConnectionInProfiles", () => {
  const connection: HostConnection = {
    id: "socket:/tmp/paseo.sock",
    type: "directSocket",
    path: "/tmp/paseo.sock",
  };

  it("gives a newly discovered host the default appearance", () => {
    const [profile] = upsertHostConnectionInProfiles({
      profiles: [],
      serverId: "srv_new",
      connection,
    });

    expect(profile.appearance).toEqual({ color: "none", badgeDisplay: null });
  });

  it("keeps the appearance the user chose when the host reconnects", () => {
    const existing: HostProfile = {
      ...makeHost("srv_known"),
      appearance: { color: "amber", badgeDisplay: "hidden" },
      connections: [],
    };

    const [profile] = upsertHostConnectionInProfiles({
      profiles: [existing],
      serverId: "srv_known",
      connection,
    });

    expect(profile.appearance).toEqual({ color: "amber", badgeDisplay: "hidden" });
  });
});

describe("resolveActiveHostServerId", () => {
  it("uses the selected host when one is set", () => {
    expect(
      resolveActiveHostServerId({
        selectedServerId: "srv_selected",
        localServerId: "srv_local",
        hosts: [makeHost("srv_local"), makeHost("srv_selected")],
        orderedHosts: [makeHost("srv_local"), makeHost("srv_selected")],
      }),
    ).toBe("srv_selected");
  });

  it("falls back to the local host when it is connected", () => {
    expect(
      resolveActiveHostServerId({
        selectedServerId: null,
        localServerId: "srv_local",
        hosts: [makeHost("srv_local"), makeHost("srv_remote")],
        orderedHosts: [makeHost("srv_local"), makeHost("srv_remote")],
      }),
    ).toBe("srv_local");
  });

  it("skips a stopped local daemon and uses the first connected host", () => {
    // Regression: a stopped local daemon's serverId persists but isn't in `hosts`.
    // Falling back to it would resolve the section to an unknown id ("host not found").
    expect(
      resolveActiveHostServerId({
        selectedServerId: null,
        localServerId: "srv_local_stopped",
        hosts: [makeHost("srv_remote")],
        orderedHosts: [makeHost("srv_remote")],
      }),
    ).toBe("srv_remote");
  });

  it("returns null when no hosts are connected", () => {
    expect(
      resolveActiveHostServerId({
        selectedServerId: null,
        localServerId: "srv_local_stopped",
        hosts: [],
        orderedHosts: [],
      }),
    ).toBeNull();
  });

  it("ignores a selected host that is not connected", () => {
    // A stale selection (e.g. the host was removed) must not be used unless it is
    // currently connected, or the section resolves to an unknown id ("host not found").
    expect(
      resolveActiveHostServerId({
        selectedServerId: "srv_stale_selection",
        localServerId: null,
        hosts: [makeHost("srv_remote")],
        orderedHosts: [makeHost("srv_remote")],
      }),
    ).toBe("srv_remote");
  });

  it("falls through a disconnected selection to the connected local host", () => {
    expect(
      resolveActiveHostServerId({
        selectedServerId: "srv_stale_selection",
        localServerId: "srv_local",
        hosts: [makeHost("srv_local"), makeHost("srv_remote")],
        orderedHosts: [makeHost("srv_local"), makeHost("srv_remote")],
      }),
    ).toBe("srv_local");
  });
});
