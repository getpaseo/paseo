import { describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import type {
  DirectTcpHostConnection,
  HostProfile,
  RelayHostConnection,
} from "@/types/host-connection";
import { resolveDownloadTransport } from "@/utils/download-transport";

const tcpConnection: DirectTcpHostConnection = {
  id: "direct:localhost:6767",
  type: "directTcp",
  endpoint: "localhost:6767",
};

const relayConnection: RelayHostConnection = {
  id: "relay:relay.paseo.sh:443",
  type: "relay",
  relayEndpoint: "relay.paseo.sh:443",
  daemonPublicKeyB64: "cHVibGljLWtleQ==",
};

function createProfile(connections: HostProfile["connections"]): HostProfile {
  return {
    serverId: "server-1",
    label: "Host",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("resolveDownloadTransport", () => {
  it("uses HTTP when the active connection is a directTcp connection of the profile", () => {
    const profile = createProfile([relayConnection, tcpConnection]);

    expect(resolveDownloadTransport(profile, tcpConnection.id)).toEqual({
      kind: "http",
      connection: tcpConnection,
    });
  });

  it("uses the session when the active connection is a relay", () => {
    const profile = createProfile([relayConnection]);

    expect(resolveDownloadTransport(profile, relayConnection.id)).toEqual({ kind: "session" });
  });

  it("uses the session when a directTcp connection exists but relay is active", () => {
    const profile = createProfile([tcpConnection, relayConnection]);

    expect(resolveDownloadTransport(profile, relayConnection.id)).toEqual({ kind: "session" });
  });

  it("uses the session without a profile or an active connection", () => {
    const profile = createProfile([tcpConnection]);

    expect(resolveDownloadTransport(undefined, tcpConnection.id)).toEqual({ kind: "session" });
    expect(resolveDownloadTransport(profile, null)).toEqual({ kind: "session" });
  });
});
