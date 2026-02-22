import type { HostConnection } from "@/contexts/daemon-registry-context";

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

export function selectBestConnection(
  input: SelectBestConnectionInput
): string | null {
  const { candidates, probeByConnectionId } = input;
  if (candidates.length === 0) {
    return null;
  }

  const available = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => {
      const probe = probeByConnectionId.get(candidate.connectionId);
      return probe?.status === "available";
    });

  const byLatency = (left: { candidate: ConnectionCandidate; index: number }, right: { candidate: ConnectionCandidate; index: number }) => {
      const leftProbe = probeByConnectionId.get(left.candidate.connectionId);
      const rightProbe = probeByConnectionId.get(right.candidate.connectionId);

      const leftLatency =
        leftProbe && leftProbe.status === "available"
          ? leftProbe.latencyMs
          : Number.POSITIVE_INFINITY;
      const rightLatency =
        rightProbe && rightProbe.status === "available"
          ? rightProbe.latencyMs
          : Number.POSITIVE_INFINITY;

      if (leftLatency === rightLatency) {
        return left.index - right.index;
      }

      return leftLatency - rightLatency;
    };

  if (available.length === 0) {
    return null;
  }

  const sorted = available.sort(byLatency);
  return sorted[0]!.candidate.connectionId;
}
