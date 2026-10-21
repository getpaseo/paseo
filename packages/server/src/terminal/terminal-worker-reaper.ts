import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import treeKill from "tree-kill";
import { writtenDuringThisBoot } from "../server/pid-lock.js";
import { connectTerminalWorker } from "./terminal-worker-client.js";
import {
  classifyTerminalProgramProcess,
  classifyTerminalWorkerProcess,
  type ProcessOwnership,
} from "./terminal-worker-ownership.js";
import {
  collectDescendants,
  createTerminalWorkerProcessInspector,
  type ProcessTableEntry,
  type TerminalWorkerProcessInspector,
} from "./terminal-worker-processes.js";
import {
  listTerminalWorkerRecords,
  retireTerminalWorkerRecord,
  writeTerminalWorkerRecord,
  type TerminalWorkerRecord,
  type TerminalWorkerTerminalEntry,
} from "./terminal-worker-record.js";

// The one kill path for terminal workers outside a connected daemon, and the one the daemon
// uses for its own kill stop. Every kill intent (stop, quit, --force, a kill restart whose
// shutdown hung, a dead or stopped worker, a program that ignores HUP) ends here:
//
// 1. Classify the worker and every terminal program of each record on its own, by birth time.
//    A record from an earlier boot names only processes the reboot ended: retire it unsignaled.
//    Descendants of owned programs (and, on Linux, members of their sessions) join the
//    candidates from one process-table snapshot taken before anything is signaled.
// 2. An owned worker gets an authenticated `shutdown`: it kills each terminal and waits for it.
// 3. After `gracefulMs`, SIGKILL whatever owned process is left, re-inspecting right before
//    each signal.
// 4. Succeed only when every candidate is gone or proven unrelated. Otherwise keep a record of
//    the unresolved entries, marked closing, and throw TerminalCleanupNotConfirmedError.

const DEFAULT_GRACEFUL_MS = 5_000;
const DEFAULT_CONFIRM_MS = 3_000;
const POLL_INTERVAL_MS = 100;

export type UnresolvedProcessReason = "still alive" | "inspection failed";

export interface UnresolvedTerminalProcess {
  pid: number;
  role: "worker" | "terminal program";
  reason: UnresolvedProcessReason;
  detail: string;
  recordPath: string;
}

export class TerminalCleanupNotConfirmedError extends Error {
  readonly code = "TERMINAL_CLEANUP_NOT_CONFIRMED";
  readonly unresolved: UnresolvedTerminalProcess[];

  constructor(unresolved: UnresolvedTerminalProcess[]) {
    super(
      [
        "Terminal cleanup was not confirmed; these processes may still be running:",
        ...unresolved.map(
          (entry) => `  pid ${entry.pid} (${entry.role}): ${entry.reason} (${entry.detail})`,
        ),
        "Their record is kept; the next `paseo daemon stop` retries the cleanup.",
      ].join("\n"),
    );
    this.name = "TerminalCleanupNotConfirmedError";
    this.unresolved = unresolved;
  }
}

/**
 * Retries the cleanup an earlier kill could not confirm (records marked closing), leaving any
 * live worker a daemon controls alone. Throws TerminalCleanupNotConfirmedError when processes
 * still survive, so a kill restart can report them.
 */
export async function retryUnconfirmedTerminalCleanup(paseoHome: string): Promise<void> {
  const recordPaths = listTerminalWorkerRecords(paseoHome).flatMap((file) =>
    "record" in file && file.record.closing ? [file.path] : [],
  );
  if (recordPaths.length === 0) return;
  await reapTerminalWorkers({ paseoHome, gracefulMs: 0, recordPaths });
}

export interface TerminalWorkerReapResult {
  records: number;
  retired: number;
  signaled: number[];
}

export interface ReapTerminalWorkersOptions {
  paseoHome: string;
  /** Time the worker gets to close its terminals before SIGKILL. 0 skips the shutdown request. */
  gracefulMs?: number;
  confirmMs?: number;
  /** Limit cleanup to these record files. Defaults to every record in the home. */
  recordPaths?: string[];
  inspector?: TerminalWorkerProcessInspector;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

interface Candidate {
  pid: number;
  startedAt: string;
  role: UnresolvedTerminalProcess["role"];
  terminalId: string;
  state: ProcessOwnership;
  // Set when the process table could not be read: this program's children were not found, so
  // its cleanup is never reported confirmed, even once the program itself is gone.
  descendantsUnavailable: string | null;
}

export async function reapTerminalWorkers(
  options: ReapTerminalWorkersOptions,
): Promise<TerminalWorkerReapResult> {
  const inspector = options.inspector ?? createTerminalWorkerProcessInspector();
  const gracefulMs = options.gracefulMs ?? DEFAULT_GRACEFUL_MS;
  const confirmMs = options.confirmMs ?? DEFAULT_CONFIRM_MS;
  const log = options.log ?? (() => {});
  const wanted = options.recordPaths ? new Set(options.recordPaths) : null;
  const result: TerminalWorkerReapResult = { records: 0, retired: 0, signaled: [] };
  const unresolved: UnresolvedTerminalProcess[] = [];

  for (const file of listTerminalWorkerRecords(options.paseoHome)) {
    if (wanted && !wanted.has(file.path)) continue;
    result.records += 1;
    if ("error" in file) {
      // Nothing in an unreadable record can identify a process, so nothing may be signaled.
      log("Skipping unreadable terminal worker record", {
        recordPath: file.path,
        error: file.error.message,
      });
      continue;
    }
    const outcome = await reapRecord({
      paseoHome: options.paseoHome,
      recordPath: file.path,
      record: file.record,
      inspector,
      gracefulMs,
      confirmMs,
      log,
    });
    result.signaled.push(...outcome.signaled);
    if (outcome.unresolved.length === 0) {
      result.retired += 1;
    } else {
      unresolved.push(...outcome.unresolved);
    }
  }

  if (unresolved.length > 0) {
    throw new TerminalCleanupNotConfirmedError(unresolved);
  }
  return result;
}

async function reapRecord(input: {
  paseoHome: string;
  recordPath: string;
  record: TerminalWorkerRecord;
  inspector: TerminalWorkerProcessInspector;
  gracefulMs: number;
  confirmMs: number;
  log: NonNullable<ReapTerminalWorkersOptions["log"]>;
}): Promise<{ signaled: number[]; unresolved: UnresolvedTerminalProcess[] }> {
  const { record, recordPath, inspector, log } = input;
  if (!writtenDuringThisBoot({ startedAt: record.createdAt, bootId: record.bootId })) {
    retireTerminalWorkerRecord(recordPath, record.socketPath);
    log("Retired terminal worker record from an earlier boot", { recordPath });
    return { signaled: [], unresolved: [] };
  }

  const tracked: TrackedProcesses = {
    record,
    inspector,
    worker: classifyTerminalWorkerProcess(record, await inspector.inspect(record.pid)),
    candidates: await collectCandidates(record, inspector, log),
  };

  if (tracked.worker.status === "owned" && input.gracefulMs > 0) {
    await requestWorkerShutdown(record, input.gracefulMs, log);
  }
  await waitUntilSettled(
    tracked,
    Date.now() + (tracked.worker.status === "owned" ? input.gracefulMs : 0),
  );

  let signaled: number[] = [];
  if (!isSettled(tracked)) {
    signaled = await forceKillOwned(tracked, recordPath, log);
    await waitUntilSettled(tracked, Date.now() + input.confirmMs);
  }

  const { unresolved, remaining } = collectUnresolved(tracked, recordPath);
  if (unresolved.length === 0) {
    retireTerminalWorkerRecord(recordPath, record.socketPath);
    log("Terminal worker record cleaned up", { recordPath, signaled });
    return { signaled, unresolved };
  }
  writeTerminalWorkerRecord(input.paseoHome, {
    ...record,
    terminals: remaining,
    closing: true,
  });
  log("Terminal worker cleanup not confirmed; record kept", {
    recordPath,
    unresolved: unresolved.map((entry) => ({ pid: entry.pid, reason: entry.reason })),
  });
  return { signaled, unresolved };
}

interface TrackedProcesses {
  record: TerminalWorkerRecord;
  inspector: TerminalWorkerProcessInspector;
  worker: ProcessOwnership;
  candidates: Candidate[];
}

function isOpen(state: ProcessOwnership): boolean {
  return state.status === "owned" || state.status === "unknown";
}

function isSettled(tracked: TrackedProcesses): boolean {
  return !isOpen(tracked.worker) && tracked.candidates.every((c) => !isOpen(c.state));
}

async function refreshTracked(tracked: TrackedProcesses): Promise<void> {
  if (isOpen(tracked.worker)) {
    tracked.worker = classifyTerminalWorkerProcess(
      tracked.record,
      await tracked.inspector.inspect(tracked.record.pid),
    );
  }
  for (const candidate of tracked.candidates) {
    if (isOpen(candidate.state)) {
      candidate.state = classifyTerminalProgramProcess(
        candidate,
        await tracked.inspector.inspect(candidate.pid),
      );
    }
  }
}

async function waitUntilSettled(tracked: TrackedProcesses, deadline: number): Promise<void> {
  await refreshTracked(tracked);
  while (!isSettled(tracked) && Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
    await refreshTracked(tracked);
  }
}

// SIGKILL every process still owned, re-inspecting each right before its signal.
async function forceKillOwned(
  tracked: TrackedProcesses,
  recordPath: string,
  log: NonNullable<ReapTerminalWorkersOptions["log"]>,
): Promise<number[]> {
  const { record, inspector } = tracked;
  const signaled: number[] = [];
  if (tracked.worker.status === "owned") {
    tracked.worker = classifyTerminalWorkerProcess(record, await inspector.inspect(record.pid));
    if (tracked.worker.status === "owned") {
      await forceKillWorker(record.pid);
      signaled.push(record.pid);
      log("Force-killed terminal worker", { pid: record.pid, recordPath });
    }
  }
  for (const candidate of tracked.candidates) {
    if (candidate.state.status !== "owned") continue;
    candidate.state = classifyTerminalProgramProcess(
      candidate,
      await inspector.inspect(candidate.pid),
    );
    if (candidate.state.status !== "owned") continue;
    forceKillProgram(candidate.pid);
    signaled.push(candidate.pid);
    log("Force-killed terminal program", {
      pid: candidate.pid,
      terminalId: candidate.terminalId,
      recordPath,
    });
  }
  return signaled;
}

function collectUnresolved(
  tracked: TrackedProcesses,
  recordPath: string,
): { unresolved: UnresolvedTerminalProcess[]; remaining: TerminalWorkerTerminalEntry[] } {
  const unresolved: UnresolvedTerminalProcess[] = [];
  if (isOpen(tracked.worker)) {
    unresolved.push(describeUnresolved(tracked.record.pid, "worker", tracked.worker, recordPath));
  }
  const remaining: TerminalWorkerTerminalEntry[] = [];
  for (const candidate of tracked.candidates) {
    const stillOpen = isOpen(candidate.state);
    if (!stillOpen && candidate.descendantsUnavailable === null) continue;
    unresolved.push(
      stillOpen
        ? describeUnresolved(candidate.pid, candidate.role, candidate.state, recordPath)
        : {
            pid: candidate.pid,
            role: candidate.role,
            reason: "inspection failed",
            detail: `its child processes could not be listed: ${candidate.descendantsUnavailable}`,
            recordPath,
          },
    );
    remaining.push({
      id: candidate.terminalId,
      pid: candidate.pid,
      startedAt: candidate.startedAt,
    });
  }
  return { unresolved, remaining };
}

async function collectCandidates(
  record: TerminalWorkerRecord,
  inspector: TerminalWorkerProcessInspector,
  log: NonNullable<ReapTerminalWorkersOptions["log"]>,
): Promise<Candidate[]> {
  const candidates = new Map<number, Candidate>();
  for (const entry of record.terminals) {
    candidates.set(entry.pid, {
      pid: entry.pid,
      startedAt: entry.startedAt,
      role: "terminal program",
      terminalId: entry.id,
      state: classifyTerminalProgramProcess(entry, await inspector.inspect(entry.pid)),
      descendantsUnavailable: null,
    });
  }
  const owned = Array.from(candidates.values()).filter((c) => c.state.status === "owned");
  if (owned.length === 0) return Array.from(candidates.values());

  let snapshot: ProcessTableEntry[];
  try {
    snapshot = await inspector.listProcesses();
  } catch (error) {
    // Without the table the programs' children cannot be found. The programs themselves are
    // still candidates; their descendants are not confirmed gone, so cleanup reports it.
    const message = error instanceof Error ? error.message : String(error);
    log("Cannot list processes for terminal cleanup", { error: message });
    for (const program of owned) {
      program.descendantsUnavailable = message;
    }
    return Array.from(candidates.values());
  }
  for (const program of owned) {
    for (const descendant of collectDescendants(snapshot, program.pid)) {
      if (candidates.has(descendant.pid)) continue;
      candidates.set(descendant.pid, {
        pid: descendant.pid,
        startedAt: descendant.startedAt,
        role: "terminal program",
        terminalId: program.terminalId,
        state: { status: "owned" },
        descendantsUnavailable: null,
      });
    }
  }
  return Array.from(candidates.values());
}

async function requestWorkerShutdown(
  record: TerminalWorkerRecord,
  gracefulMs: number,
  log: NonNullable<ReapTerminalWorkersOptions["log"]>,
): Promise<void> {
  const deadline = Date.now() + gracefulMs;
  let connection;
  try {
    connection = await connectTerminalWorker({
      socketPath: record.socketPath,
      secret: record.secret,
      timeoutMs: Math.min(gracefulMs, 2_000),
    });
  } catch (error) {
    // A worker that cannot be reached is escalated by birth time below; a failed connection
    // alone never authorizes a signal.
    log("Terminal worker did not accept a shutdown request", {
      pid: record.pid,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const responded = new Promise<void>((resolve) => {
    connection.on("message", (message) => {
      if (message.type === "response") resolve();
    });
  });
  const closed = new Promise<void>((resolve) => connection.on("close", () => resolve()));
  const sendFailed = new Promise<void>((resolve) => {
    connection.send({ type: "shutdown", requestId: randomUUID() }, (error) => {
      if (error) resolve();
    });
  });
  const timeout = new AbortController();
  await Promise.race([
    responded,
    closed,
    sendFailed,
    delay(Math.max(0, deadline - Date.now()), undefined, { signal: timeout.signal }).catch(
      () => undefined,
    ),
  ]);
  timeout.abort();
  connection.disconnect();
}

function forceKillWorker(pid: number): Promise<void> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      treeKill(pid, "SIGKILL", () => resolve());
    });
  }
  signalIgnoringMissing(pid, "SIGKILL");
  return Promise.resolve();
}

function forceKillProgram(pid: number): void {
  if (process.platform !== "win32") {
    // A PTY program leads its own session and process group. The group cannot outlive its
    // leader's pid while any member is alive, so it holds nothing but this program's job.
    signalIgnoringMissing(-pid, "SIGKILL");
  }
  signalIgnoringMissing(pid, "SIGKILL");
}

function signalIgnoringMissing(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

function describeUnresolved(
  pid: number,
  role: UnresolvedTerminalProcess["role"],
  state: ProcessOwnership,
  recordPath: string,
): UnresolvedTerminalProcess {
  return {
    pid,
    role,
    reason: state.status === "unknown" ? "inspection failed" : "still alive",
    detail: state.status === "unknown" ? state.reason : "survived SIGKILL",
    recordPath,
  };
}
