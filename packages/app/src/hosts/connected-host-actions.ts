import type { HostSummary, PaseoHostActions } from "@getpaseo/client";
import { serializeRelayConnectionUri } from "@getpaseo/protocol/daemon-endpoints";
import { parseHostTarget } from "@getpaseo/protocol/host-target";
import type { DaemonPermission } from "@getpaseo/protocol/messages";

export type ReverseAccess = "read" | "write";

export function parseDaemonConnection(input: string, password: string): string {
  const address = input.trim();
  const target = parseHostTarget(address);
  if (!password) return address;
  if (target.kind === "socket" && target.offer) {
    return serializeRelayConnectionUri({ offer: target.offer, password });
  }
  if (target.kind === "socket" && target.socketPath) {
    throw new Error("A password cannot be added to a local socket address");
  }
  const url = new URL(address.includes("://") ? address : target.description);
  url.searchParams.set("password", password);
  return url.toString();
}

export async function approveReverseHost(
  origin: PaseoHostActions,
  host: HostSummary,
  label: string,
  access: ReverseAccess,
  token: string,
): Promise<void> {
  const { self, hosts } = await origin.list();
  const outbound = hosts.find((entry) => entry.registrationId === host.registrationId);
  if (!outbound?.serverId || outbound.serverId !== host.serverId || outbound.status !== "online") {
    throw new Error(
      "The connected host changed or went offline. Refresh its status and try again.",
    );
  }
  if (outbound.reverseEnabled) return;
  const peer = await origin.client(outbound.serverId);
  try {
    const approval = await peer.hosts.add({
      connection: `reverse://${self.serverId}`,
      incomingToken: token,
      label,
      sourceKey: `reverse:${self.serverId}:${host.registrationId}`,
    });
    const permissions: DaemonPermission[] = ["daemon.read", "workspace.read"];
    if (access === "write") permissions.push("workspace.write");
    try {
      await origin.update(host.registrationId, { reverseOffer: { token, permissions } });
    } catch (error) {
      // An unknown outcome may already have saved the grant. Keep the peer approval
      // in that case so an acknowledged reconnect can complete both sides.
      if (
        !(error && typeof error === "object" && "outcome" in error && error.outcome === "unknown")
      ) {
        await peer.hosts.remove(approval.registrationId).catch(() => undefined);
      }
      throw error;
    }
  } finally {
    await peer.dispose().catch(() => undefined);
  }
}

export async function revokeReverseHost(
  origin: PaseoHostActions,
  host: HostSummary,
): Promise<void> {
  const { self } = await origin.list();
  await origin.update(host.registrationId, { reverseOffer: null });
  if (!host.serverId || host.status !== "online") return;

  const peer = await origin.client(host.serverId);
  try {
    const { hosts } = await peer.hosts.list();
    const approval = hosts.find(
      (entry) =>
        entry.direction === "incoming" &&
        entry.source.key === `reverse:${self.serverId}:${host.registrationId}`,
    );
    if (approval) await peer.hosts.remove(approval.registrationId);
  } finally {
    await peer.dispose().catch(() => undefined);
  }
}
