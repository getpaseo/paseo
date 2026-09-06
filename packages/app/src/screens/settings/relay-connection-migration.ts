import { shouldUseTlsForDefaultHostedRelay } from "@getpaseo/protocol/daemon-endpoints";
import type { HostProfile } from "@/types/host-connection";

export interface RelayConnectionMigration {
  serverId: string;
  relayEndpoint: string;
  useTls: boolean;
  daemonPublicKeyB64: string;
  label: string;
}

export function buildRelayConnectionMigration(input: {
  host: HostProfile;
  publicEndpoint: string;
  publicUseTls: boolean;
}): RelayConnectionMigration | null {
  const relayConnections = input.host.connections.filter(
    (connection) => connection.type === "relay",
  );
  const existing = relayConnections[0];
  if (!existing) return null;

  const alreadyStored = relayConnections.some(
    (connection) =>
      connection.relayEndpoint === input.publicEndpoint &&
      (connection.useTls ?? shouldUseTlsForDefaultHostedRelay(connection.relayEndpoint)) ===
        input.publicUseTls,
  );
  if (alreadyStored) return null;

  return {
    serverId: input.host.serverId,
    relayEndpoint: input.publicEndpoint,
    useTls: input.publicUseTls,
    daemonPublicKeyB64: existing.daemonPublicKeyB64,
    label: input.host.label,
  };
}
