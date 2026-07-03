import { describe, expect, it } from "vitest";
import {
  normalizeStoredHostProfile,
  orderHostsLocalFirst,
  type HostProfile,
} from "./host-connection";

function makeHost(serverId: string): HostProfile {
  return {
    serverId,
    label: serverId,
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
});
