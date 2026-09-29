import type { DirectTcpHostConnection, HostProfile } from "@/types/host-connection";

export type DownloadTransport =
  | { kind: "http"; connection: DirectTcpHostConnection }
  | { kind: "session" };

/**
 * The HTTP download endpoint is only reachable when the app talks to the
 * daemon over direct TCP. Every other connection (relay, SSH, sockets)
 * streams the file over the session instead.
 */
export function resolveDownloadTransport(
  profile: HostProfile | undefined,
  activeConnectionId: string | null,
): DownloadTransport {
  if (!profile || !activeConnectionId) {
    return { kind: "session" };
  }
  const activeConnection = profile.connections.find(
    (connection) => connection.id === activeConnectionId,
  );
  if (activeConnection?.type !== "directTcp") {
    return { kind: "session" };
  }
  return { kind: "http", connection: activeConnection };
}
