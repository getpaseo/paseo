import type { HostConnection } from "@/types/host-connection";

export type ConnectionCandidate = {
  connectionId: string;
  connection: HostConnection;
};

export type ConnectionProbeState =
  | { status: "pending"; latencyMs: null }
  | { status: "unavailable"; latencyMs: null }
  | { status: "available"; latencyMs: number };

export type SelectBestConnectionInput = {
  candidates: ConnectionCandidate[];
  probeByConnectionId: Map<string, ConnectionProbeState>;
};

function getAvailableLatency(input: {
  connectionId: string;
  probeByConnectionId: Map<string, ConnectionProbeState>;
}): number | null {
  const probe = input.probeByConnectionId.get(input.connectionId);
  return probe?.status === "available" ? probe.latencyMs : null;
}

export function selectBestConnection(input: SelectBestConnectionInput): string | null {
  const { candidates, probeByConnectionId } = input;
  if (candidates.length === 0) {
    return null;
  }

  let bestConnectionId: string | null = null;
  let bestLatency: number | null = null;

  for (const candidate of candidates) {
    const latencyMs = getAvailableLatency({
      connectionId: candidate.connectionId,
      probeByConnectionId,
    });
    if (latencyMs === null) {
      continue;
    }
    if (bestLatency === null || latencyMs < bestLatency) {
      bestConnectionId = candidate.connectionId;
      bestLatency = latencyMs;
    }
  }

  return bestConnectionId;
}
