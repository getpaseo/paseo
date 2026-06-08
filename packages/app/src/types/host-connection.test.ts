import { describe, expect, it } from "vitest";
import {
  type HostProfile,
  normalizeStoredHostProfile,
  upsertHostConnectionInProfiles,
} from "./host-connection";

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

  it("deduplicates stored direct TCP connections after endpoint normalization", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_duplicate",
      label: "Duplicate Host",
      connections: [
        {
          id: "direct:127.0.0.1:6767",
          type: "directTcp",
          endpoint: "127.0.0.1:6767",
          useTls: false,
          password: "secret",
        },
        {
          id: "direct:localhost:6767",
          type: "directTcp",
          endpoint: "localhost:6767",
          useTls: false,
          password: "secret",
        },
      ],
      preferredConnectionId: "direct:127.0.0.1:6767",
    });

    expect(profile?.connections).toEqual([
      {
        id: "direct:localhost:6767",
        type: "directTcp",
        endpoint: "localhost:6767",
        useTls: false,
        password: "secret",
      },
    ]);
    expect(profile?.preferredConnectionId).toBe("direct:localhost:6767");
  });

  it("deduplicates stored direct TCP connections with the same id even when auth fields differ", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_duplicate_auth",
      label: "Duplicate Host",
      connections: [
        {
          id: "direct:localhost:6767",
          type: "directTcp",
          endpoint: "localhost:6767",
          useTls: false,
          password: "secret",
        },
        {
          id: "direct:localhost:6767",
          type: "directTcp",
          endpoint: "localhost:6767",
          useTls: false,
        },
      ],
      preferredConnectionId: "direct:localhost:6767",
    });

    expect(profile?.connections).toEqual([
      {
        id: "direct:localhost:6767",
        type: "directTcp",
        endpoint: "localhost:6767",
        useTls: false,
        password: "secret",
      },
    ]);
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

describe("upsertHostConnectionInProfiles", () => {
  it("replaces an existing direct TCP connection when the incoming connection omits password", () => {
    const profiles: HostProfile[] = [
      {
        serverId: "srv_password",
        label: "Password Host",
        lifecycle: {},
        connections: [
          {
            id: "direct:localhost:6767",
            type: "directTcp",
            endpoint: "localhost:6767",
            useTls: false,
            password: "old-secret",
          },
        ],
        preferredConnectionId: "direct:localhost:6767",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const next = upsertHostConnectionInProfiles({
      profiles,
      serverId: "srv_password",
      connection: {
        id: "direct:localhost:6767",
        type: "directTcp",
        endpoint: "localhost:6767",
        useTls: false,
      },
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(next[0]?.connections).toEqual([
      {
        id: "direct:localhost:6767",
        type: "directTcp",
        endpoint: "localhost:6767",
        useTls: false,
      },
    ]);
    expect(next[0]?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});
