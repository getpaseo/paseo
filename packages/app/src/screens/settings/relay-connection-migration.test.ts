import { describe, expect, it } from "vitest";
import type { HostProfile } from "@/types/host-connection";
import { buildRelayConnectionMigration } from "./relay-connection-migration";

const host: HostProfile = {
  serverId: "host-a",
  label: "Workstation",
  appearance: { color: "blue", badgeDisplay: "name" },
  lifecycle: {},
  connections: [
    {
      id: "relay:wss:relay.old.example:443",
      type: "relay",
      relayEndpoint: "relay.old.example:443",
      useTls: true,
      daemonPublicKeyB64: "daemon-key",
    },
  ],
  preferredConnectionId: "relay:wss:relay.old.example:443",
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

describe("relay connection migration", () => {
  it("builds a new local relay connection using the existing daemon key", () => {
    expect(
      buildRelayConnectionMigration({
        host,
        publicEndpoint: "relay.new.example:7443",
        publicUseTls: false,
      }),
    ).toEqual({
      serverId: "host-a",
      relayEndpoint: "relay.new.example:7443",
      useTls: false,
      daemonPublicKeyB64: "daemon-key",
      label: "Workstation",
    });
  });

  it("does nothing when the desired relay connection is already stored", () => {
    expect(
      buildRelayConnectionMigration({
        host,
        publicEndpoint: "relay.old.example:443",
        publicUseTls: true,
      }),
    ).toBeNull();
  });

  it("does nothing for a host that has never been paired through relay", () => {
    expect(
      buildRelayConnectionMigration({
        host: { ...host, connections: [] },
        publicEndpoint: "relay.new.example:443",
        publicUseTls: true,
      }),
    ).toBeNull();
  });
});
