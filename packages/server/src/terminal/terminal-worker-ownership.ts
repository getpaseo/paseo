import type { ManagedProcessInspection } from "../server/managed-processes/managed-processes.js";
import { probeTerminalWorkerSocket } from "./terminal-worker-client.js";
import type { TerminalWorkerProcessInspector } from "./terminal-worker-processes.js";
import { TERMINAL_WORKER_MARKER_ARG, type TerminalWorkerRecord } from "./terminal-worker-record.js";

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

/**
 * Who the pid a worker record names belongs to now. Only a matching birth time and worker
 * marker make it owned, the one state cleanup may signal. When the process table cannot tell
 * (the query failed, or the worker could not read its own identity), the worker's socket
 * decides between unknown and unrelated: a live worker listens until it exits, so a refused
 * connection means the pid now runs something else, or a worker already on its way out.
 */
export async function identifyTerminalWorker(
  record: Pick<TerminalWorkerRecord, "recordId" | "identity" | "pid" | "socketPath">,
  inspector: Pick<TerminalWorkerProcessInspector, "inspect">,
): Promise<ProcessOwnership> {
  const ownership = classifyTerminalWorkerProcess(record, await inspector.inspect(record.pid));
  if (ownership.status !== "unknown") return ownership;
  if ((await probeTerminalWorkerSocket(record.socketPath)) === "refused") {
    return { status: "unrelated", reason: "nothing listens on its socket" };
  }
  return ownership;
}

export function classifyTerminalWorkerProcess(
  record: Pick<TerminalWorkerRecord, "recordId" | "identity">,
  inspection: ManagedProcessInspection,
): ProcessOwnership {
  if ("unavailable" in record.identity) {
    if (inspection.status === "not-found") return { status: "gone" };
    return {
      status: "unknown",
      reason: `the worker could not read its own identity: ${record.identity.unavailable}`,
    };
  }
  const birth = classifyBirth(record.identity.startedAt, inspection);
  if (birth.status !== "owned" || inspection.status !== "alive") return birth;
  const commandLine = inspection.snapshot.commandLine;
  if (!commandLine) {
    return { status: "unknown", reason: "command line unavailable" };
  }
  if (!hasWorkerMarker(commandLine, record.recordId)) {
    return { status: "unrelated", reason: "command line lacks the worker marker" };
  }
  return { status: "owned" };
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

function hasWorkerMarker(commandLine: string, recordId: string): boolean {
  const tokens = commandLine.split(/\s+/);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === TERMINAL_WORKER_MARKER_ARG && tokens[index + 1] === recordId) {
      return true;
    }
  }
  return false;
}
