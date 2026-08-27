import { appendFile } from "node:fs/promises";

interface GitCommandTraceContext {
  id: string;
  args: string[];
  cwd: string;
  submittedAtMs: number;
  startedAtMs: number | null;
  spawnedAtMs: number | null;
  pid: number | null;
  submittedQueue: GitCommandTraceQueueState;
  startedQueue: GitCommandTraceQueueState | null;
  settled: boolean;
}

interface GitCommandTraceQueueState {
  active: number;
  pending: number;
}

interface GitCommandTraceSettlement {
  outcome: "closed" | "spawn_error" | "timed_out";
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  truncated?: boolean;
}

let nextTraceId = 1;
let pendingTraceWrite = Promise.resolve();

function appendTrace(event: Record<string, unknown>): void {
  const tracePath = process.env.PASEO_GIT_TRACE_FILE?.trim();
  if (!tracePath) return;

  pendingTraceWrite = pendingTraceWrite
    .then(() => appendFile(tracePath, `${JSON.stringify(event)}\n`, "utf8"))
    .catch(() => {
      // Diagnostic tracing must never change command execution.
    });
}

export async function flushGitCommandTrace(): Promise<void> {
  await pendingTraceWrite;
}

export function submitGitCommandTrace(
  args: string[],
  cwd: string,
  queue: GitCommandTraceQueueState,
): GitCommandTraceContext | null {
  if (!process.env.PASEO_GIT_TRACE_FILE?.trim()) return null;

  const submittedAtMs = Date.now();
  const context: GitCommandTraceContext = {
    id: `${process.pid}:${nextTraceId++}`,
    args: [...args],
    cwd,
    submittedAtMs,
    startedAtMs: null,
    spawnedAtMs: null,
    pid: null,
    submittedQueue: { ...queue },
    startedQueue: null,
    settled: false,
  };
  return context;
}

export function startGitCommandTrace(
  context: GitCommandTraceContext | null,
  queue: GitCommandTraceQueueState,
): void {
  if (!context) return;

  context.startedAtMs = Date.now();
  context.startedQueue = { ...queue };
}

export function spawnGitCommandTrace(
  context: GitCommandTraceContext | null,
  pid: number | undefined,
): void {
  if (!context) return;

  context.spawnedAtMs = Date.now();
  context.pid = pid ?? null;
}

export function settleGitCommandTrace(
  context: GitCommandTraceContext | null,
  settlement: GitCommandTraceSettlement,
): void {
  if (!context || context.settled) return;
  context.settled = true;

  const atMs = Date.now();
  appendTrace({
    kind: "git_command",
    event: "settled",
    id: context.id,
    atMs,
    submittedAtMs: context.submittedAtMs,
    startedAtMs: context.startedAtMs,
    args: context.args,
    cwd: context.cwd,
    queueWaitMs: context.startedAtMs === null ? null : context.startedAtMs - context.submittedAtMs,
    spawnCallMs:
      context.startedAtMs === null || context.spawnedAtMs === null
        ? null
        : context.spawnedAtMs - context.startedAtMs,
    pid: context.pid,
    queue: {
      submitted: context.submittedQueue,
      started: context.startedQueue,
    },
    durationMs: atMs - context.submittedAtMs,
    ...settlement,
  });
}
