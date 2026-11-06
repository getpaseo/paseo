import type { ManagedProcessInspection } from "../server/managed-processes/managed-processes.js";
import { probeTerminalWorkerSocket } from "./terminal-worker-client.js";
import { type TerminalWorkerRecord } from "./terminal-worker-record.js";

// Who a pid named in a terminal worker record belongs to, before anything signals it.
//
// This is deliberately not `processIdentityMatches` from managed-processes.ts: that matcher
// falls back to command text when a birth time is missing, and requires the original argv when
// it is present. A terminal program is often a shell that ran `exec`, which keeps its pid and
// birth time but changes its command line; and a reused pid can run the same command line.
// Here birth time alone identifies a terminal program, and nothing without one is ever owned.

export type ProcessOwnership =
  | { status: "gone" }
  | { status: "unrelated"; reason: string }
  | { status: "owned" }
  | { status: "unknown"; reason: string };

/** The home lock owns these records; the record-specific socket proves a live worker. */
export async function identifyTerminalWorker(
  record: Pick<TerminalWorkerRecord, "pid" | "socketPath">,
): Promise<ProcessOwnership> {
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return { status: "gone" };
  }
  const socket = await probeTerminalWorkerSocket(record.socketPath);
  if (socket === "refused") return { status: "gone" };
  if (socket === "accepting") return { status: "owned" };
  return { status: "unknown", reason: "worker socket probe inconclusive" };
}

export function classifyTerminalProgramProcess(
  entry: { startedAt: string | null },
  inspection: ManagedProcessInspection,
): ProcessOwnership {
  return classifyBirth(entry.startedAt, inspection);
}

function classifyBirth(
  recordedStartedAt: string | null,
  inspection: ManagedProcessInspection,
): ProcessOwnership {
  if (inspection.status === "not-found") return { status: "gone" };
  if (inspection.status === "error") {
    const message =
      inspection.error instanceof Error ? inspection.error.message : String(inspection.error);
    return { status: "unknown", reason: `inspection failed: ${message}` };
  }
  const startedAt = inspection.snapshot.startedAt;
  if (!recordedStartedAt || !startedAt) {
    return { status: "unknown", reason: "birth time unavailable" };
  }
  if (startedAt !== recordedStartedAt) {
    return { status: "unrelated", reason: "pid reused by a process with another birth time" };
  }
  return { status: "owned" };
}
