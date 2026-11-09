import { describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import {
  createRemoteSshHostConnection,
  normalizeStoredHostProfile,
  orderHostsLocalFirst,
  pinRelayProtectedSecurityInProfiles,
  relayConnectionFromOffer,
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

  it("moves a stored direct TCP password to the host profile", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_legacy",
      connections: [{ type: "directTcp", endpoint: "localhost:6767", password: "old-secret" }],
    });
    expect(profile?.password).toBe("old-secret");
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

  it("normalizes stored Remote SSH connection parameters", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_ssh",
      connections: [
        {
          type: "remoteSsh",
          host: " deploy@example.com ",
          sshPort: 2222,
          daemonPort: 7777,
        },
      ],
    });

    expect(profile?.connections[0]).toEqual({
      id: "ssh:deploy%40example.com:2222:7777",
      type: "remoteSsh",
      host: "deploy@example.com",
      sshPort: 2222,
      daemonPort: 7777,
    });
  });
});

describe("createRemoteSshHostConnection", () => {
  it("keeps optional SSH settings absent", () => {
    expect(createRemoteSshHostConnection({ host: "build-box" })).toEqual({
      id: "ssh:build-box::",
      type: "remoteSsh",
      host: "build-box",
    });
  });

  it("rejects invalid SSH destinations and ports", () => {
    expect(() => createRemoteSshHostConnection({ host: "" })).toThrow("SSH host is required");
    expect(() => createRemoteSshHostConnection({ host: "bad host" })).toThrow(
      "SSH host is invalid",
    );
    expect(() => createRemoteSshHostConnection({ host: "build-box", sshPort: 70000 })).toThrow(
      "SSH port must be between 1 and 65535",
    );
    expect(() => createRemoteSshHostConnection({ host: "build-box", daemonPort: 0 })).toThrow(
      "Daemon port must be between 1 and 65535",
    );
  });
});

describe("upsertHostConnectionInProfiles", () => {
  const connection: HostConnection = {
    id: "socket:/tmp/paseo.sock",
    type: "directSocket",
    path: "/tmp/paseo.sock",
  };

  it.each([false, true])(
    "keeps destinations distinct when a persisted route shares an origin (C already saved: %s)",
    (savedC) => {
      const route: HostConnection = { id: "via:srv_a", type: "routed", originServerId: "srv_a" };
      const directB: HostConnection = {
        id: "direct:b:6767",
        type: "directTcp",
        endpoint: "b:6767",
      };
      const directC: HostConnection = {
        id: "direct:c:6767",
        type: "directTcp",
        endpoint: "c:6767",
      };
      const b: HostProfile = {
        ...makeHost("srv_b"),
        label: "My B",
        connections: [route, directB],
        preferredConnectionId: route.id,
      };
      const c: HostProfile = {
        ...makeHost("srv_c"),
        label: "My C",
        connections: [directC],
        preferredConnectionId: directC.id,
      };
      const profiles = upsertHostConnectionInProfiles({
        profiles: savedC ? [b, c] : [b],
        serverId: "srv_c",
        label: "Fleet C",
        connection: route,
      });
      expect(profiles).toHaveLength(2);
      expect(profiles[0]).toEqual(b);
      expect(profiles[1]).toMatchObject({
        serverId: "srv_c",
        label: savedC ? "My C" : "Fleet C",
        connections: savedC ? [directC, route] : [route],
        preferredConnectionId: savedC ? directC.id : route.id,
      });
      expect(
        upsertHostConnectionInProfiles({
          profiles,
          serverId: "srv_b",
          label: "Fleet B",
          connection: route,
        }),
      ).toBe(profiles);
    },
  );

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

  it("replaces a direct connection when its settings change", () => {
    const existingConnection: HostConnection = {
      id: "direct:example.test:6767",
      type: "directTcp",
      endpoint: "example.test:6767",
      useTls: false,
    };
    const existing: HostProfile = {
      ...makeHost("srv_known"),
      password: "old-secret",
      connections: [existingConnection],
      preferredConnectionId: existingConnection.id,
    };
    const replacement: HostConnection = {
      ...existingConnection,
      useTls: true,
    };

    const [profile] = upsertHostConnectionInProfiles({
      profiles: [existing],
      serverId: "srv_known",
      connection: replacement,
      password: "new-secret",
    });

    expect(profile.connections).toEqual([replacement]);
    expect("password" in profile.connections[0]!).toBe(false);
    expect(profile.password).toBe("new-secret");
    expect(profile.preferredConnectionId).toBe(replacement.id);
  });
});

describe("relay endpoint security pin", () => {
  const pinned: HostConnection = {
    id: "relay:wss:relay.example.com:443",
    type: "relay",
    relayEndpoint: "relay.example.com:443",
    useTls: true,
    daemonPublicKeyB64: "pk_a",
    minimumSecurityMode: "protected",
  };
  const unpinned: HostConnection = {
    id: pinned.id,
    type: "relay",
    relayEndpoint: "relay.example.com:443",
    useTls: true,
    daemonPublicKeyB64: "pk_a",
  };

  it("survives storage", () => {
    const profile = normalizeStoredHostProfile({ serverId: "srv", connections: [pinned] });
    expect(profile?.connections[0]).toEqual(pinned);
  });

  it("comes from a pairing offer that requires protected security", () => {
    const offer: Parameters<typeof relayConnectionFromOffer>[0] = {
      v: 2,
      serverId: "srv",
      daemonPublicKeyB64: "pk_a",
      relay: { endpoint: "relay.example.com:443", useTls: true },
      minimumSecurityMode: "protected",
    };
    expect(relayConnectionFromOffer(offer)).toEqual(pinned);
    expect(relayConnectionFromOffer({ ...offer, minimumSecurityMode: undefined })).toEqual(
      unpinned,
    );
  });

  it("is kept when the same daemon identity is paired again without it", () => {
    const profiles = upsertHostConnectionInProfiles({
      profiles: [{ ...makeHost("srv"), connections: [pinned], preferredConnectionId: pinned.id }],
      serverId: "srv",
      connection: unpinned,
    });
    expect(profiles[0].connections).toEqual([pinned]);
  });

  it("is persisted when a strict offer re-imports an unpinned route", () => {
    const profiles = [
      { ...makeHost("srv"), connections: [unpinned], preferredConnectionId: unpinned.id },
    ];
    const next = upsertHostConnectionInProfiles({
      profiles,
      serverId: "srv",
      connection: pinned,
    });
    expect(next).not.toBe(profiles);
    expect(next[0].connections).toEqual([pinned]);
  });

  it("tightens every route to the same daemon identity when a strict offer arrives through another relay", () => {
    const strictElsewhere: HostConnection = {
      id: "relay:wss:other.example.com:443",
      type: "relay",
      relayEndpoint: "other.example.com:443",
      useTls: true,
      daemonPublicKeyB64: "pk_a",
      minimumSecurityMode: "protected",
    };
    const profiles = upsertHostConnectionInProfiles({
      profiles: [
        { ...makeHost("srv"), connections: [unpinned], preferredConnectionId: unpinned.id },
      ],
      serverId: "srv",
      connection: strictElsewhere,
    });
    expect(profiles[0].connections).toEqual([pinned, strictElsewhere]);
  });

  it("follows the daemon identity to a relay at another address", () => {
    const elsewhere: HostConnection = {
      id: "relay:wss:other.example.com:443",
      type: "relay",
      relayEndpoint: "other.example.com:443",
      useTls: true,
      daemonPublicKeyB64: "pk_a",
    };
    const profiles = upsertHostConnectionInProfiles({
      profiles: [{ ...makeHost("srv"), connections: [pinned], preferredConnectionId: pinned.id }],
      serverId: "srv",
      connection: elsewhere,
    });
    expect(profiles[0].connections).toEqual([
      pinned,
      { ...elsewhere, minimumSecurityMode: "protected" },
    ]);
  });

  it("does not carry over to a different daemon identity", () => {
    const rotated: HostConnection = { ...unpinned, daemonPublicKeyB64: "pk_b" };
    const profiles = upsertHostConnectionInProfiles({
      profiles: [{ ...makeHost("srv"), connections: [pinned], preferredConnectionId: pinned.id }],
      serverId: "srv",
      connection: rotated,
    });
    expect(profiles[0].connections).toEqual([rotated]);
  });

  it("is learned for every relay route to the identity that negotiated protected security", () => {
    const elsewhere: HostConnection = {
      ...unpinned,
      id: "relay:wss:other.example.com:443",
      relayEndpoint: "other.example.com:443",
    };
    const rotated: HostConnection = {
      ...unpinned,
      id: "relay:wss:rotated.example.com:443",
      relayEndpoint: "rotated.example.com:443",
      daemonPublicKeyB64: "pk_b",
    };
    const profiles = [{ ...makeHost("srv"), connections: [unpinned, elsewhere, rotated] }];
    const next = pinRelayProtectedSecurityInProfiles({
      profiles,
      serverId: "srv",
      daemonPublicKeyB64: "pk_a",
      now: "2026-02-01T00:00:00.000Z",
    });
    expect(next[0].connections).toEqual([
      pinned,
      { ...elsewhere, minimumSecurityMode: "protected" },
      rotated,
    ]);
    expect(next[0].updatedAt).toBe("2026-02-01T00:00:00.000Z");

    expect(
      pinRelayProtectedSecurityInProfiles({
        profiles: next,
        serverId: "srv",
        daemonPublicKeyB64: "pk_a",
      }),
    ).toBe(next);
    expect(
      pinRelayProtectedSecurityInProfiles({
        profiles,
        serverId: "srv",
        daemonPublicKeyB64: "pk_other",
      }),
    ).toBe(profiles);
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
