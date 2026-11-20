import { createContext, useContext, type ReactNode } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface PullRequestConnection {
  client: Pick<DaemonClient, "checkoutPrStatus" | "pullRequestTimeline"> | null;
  isConnected: boolean;
}
const ConnectionContext = createContext<((serverId: string) => PullRequestConnection) | null>(null);

/** Supplies the PR read connection, shared by discovery, rail status and timeline content. */
export function PullRequestConnectionProvider({
  connection,
  children,
}: {
  connection: (serverId: string) => PullRequestConnection;
  children: ReactNode;
}) {
  return <ConnectionContext value={connection}>{children}</ConnectionContext>;
}

export function usePullRequestConnection(serverId: string): PullRequestConnection {
  const supplied = useContext(ConnectionContext);
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  return supplied ? supplied(serverId) : { client, isConnected };
}
