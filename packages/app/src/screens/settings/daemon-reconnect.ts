export interface DaemonConnectionMarker {
  clientGeneration: number;
  lastOnlineAt: string | null;
}

interface DaemonConnectionSnapshot extends DaemonConnectionMarker {
  connectionStatus: "idle" | "connecting" | "online" | "offline" | "error";
}

export function hasDaemonReconnectedAfter(
  snapshot: DaemonConnectionSnapshot | null,
  start: DaemonConnectionMarker | null,
): boolean {
  if (snapshot?.connectionStatus !== "online") return false;
  if (!start) return true;
  return (
    snapshot.clientGeneration !== start.clientGeneration ||
    snapshot.lastOnlineAt !== start.lastOnlineAt
  );
}
