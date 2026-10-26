import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import treeKill from "tree-kill";

export interface TreeKillTarget {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once?(event: "exit", listener: () => void): unknown;
}

export interface TerminateWithTreeKillOptions {
  gracefulSignal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  gracefulTimeoutMs: number;
  forceTimeoutMs?: number;
  onForceSignal?: () => void;
  // The graceful signal never reaches descendants that called setsid(): the
  // process that detached them decides whether they outlive it. The force
  // signal still reaps them, so a target that ignores the graceful signal
  // cannot leave orphans behind. Set this when the target may front a daemon
  // that other processes share (jcode's `acp` adapters share one `jcode serve`),
  // where killing it is worse than leaving it running.
  spareDetachedOnForce?: boolean;
}

export type TerminateWithTreeKillResult =
  | "already-exited"
  | "terminated"
  | "killed"
  | "kill-timeout";

// Injection seam: production wires terminateWithTreeKill; tests wire a fake that
// records which children were terminated as observable state.
export type ProcessTerminator = (
  child: TreeKillTarget,
  options: TerminateWithTreeKillOptions,
) => Promise<TerminateWithTreeKillResult>;

export interface ProcessTableEntry {
  pid: number;
  ppid: number;
  sessionLeader: boolean;
}

// Resolves null when no process table is available; callers then fall back to
// signalling the whole tree.
export type ProcessTableReader = () => Promise<ProcessTableEntry[] | null>;

export interface TreeKillDependencies {
  readProcessTable: ProcessTableReader;
  signalPid: (pid: number, signal: NodeJS.Signals) => void;
  signalTree: (child: TreeKillTarget, signal: NodeJS.Signals) => Promise<void>;
}

export function createTreeKillTerminator(
  dependencies: Partial<TreeKillDependencies> = {},
): ProcessTerminator {
  const deps: TreeKillDependencies = {
    readProcessTable: dependencies.readProcessTable ?? readProcessTable,
    signalPid: dependencies.signalPid ?? ((pid, signal) => process.kill(pid, signal)),
    signalTree: dependencies.signalTree ?? signalProcessTree,
  };

  return async (child, options) => {
    if (isProcessExited(child)) {
      return "already-exited";
    }

    const exitPromise = waitForProcessExit(child);
    await signalAttachedProcessTree(child, options.gracefulSignal ?? "SIGTERM", deps);
    if (await waitForExitOrTimeout(exitPromise, options.gracefulTimeoutMs)) {
      return "terminated";
    }

    options.onForceSignal?.();
    const forceSignal = options.forceSignal ?? "SIGKILL";
    if (options.spareDetachedOnForce) {
      await signalAttachedProcessTree(child, forceSignal, deps);
    } else {
      await deps.signalTree(child, forceSignal);
    }
    if (options.forceTimeoutMs === undefined) {
      return "killed";
    }
    return (await waitForExitOrTimeout(exitPromise, options.forceTimeoutMs))
      ? "killed"
      : "kill-timeout";
  };
}

export const terminateWithTreeKill: ProcessTerminator = createTreeKillTerminator();

export function signalProcessTree(child: TreeKillTarget, signal: NodeJS.Signals): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    signalDirectChild(child, signal);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    treeKill(pid, signal, (error) => {
      if (error) {
        signalDirectChild(child, signal);
      }
      resolve();
    });
  });
}

// The root plus every descendant still in its session. A descendant that leads
// its own session called setsid() to detach (daemons, `spawn({ detached: true })`),
// so it and its subtree are left out. Process groups are not the boundary: shell
// job control gives each pipeline its own group inside the same session.
export function selectAttachedProcessTree(
  table: readonly ProcessTableEntry[],
  rootPid: number,
): number[] {
  const childrenByParent = new Map<number, ProcessTableEntry[]>();
  for (const entry of table) {
    if (entry.pid === rootPid) continue;
    const siblings = childrenByParent.get(entry.ppid);
    if (siblings) {
      siblings.push(entry);
    } else {
      childrenByParent.set(entry.ppid, [entry]);
    }
  }

  const attached = [rootPid];
  const visited = new Set(attached);
  for (let index = 0; index < attached.length; index += 1) {
    for (const child of childrenByParent.get(attached[index]) ?? []) {
      if (child.sessionLeader || visited.has(child.pid)) continue;
      visited.add(child.pid);
      attached.push(child.pid);
    }
  }
  return attached;
}

async function signalAttachedProcessTree(
  child: TreeKillTarget,
  signal: NodeJS.Signals,
  deps: TreeKillDependencies,
): Promise<void> {
  if (isProcessExited(child)) {
    return;
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    signalDirectChild(child, signal);
    return;
  }

  const table = await deps.readProcessTable().catch(() => null);
  if (!table) {
    await deps.signalTree(child, signal);
    return;
  }

  for (const target of selectAttachedProcessTree(table, pid)) {
    try {
      deps.signalPid(target, signal);
    } catch {
      if (target === pid) {
        signalDirectChild(child, signal);
      }
      // Descendants that exited since the snapshot are already gone.
    }
  }
}

export function readProcessTable(): Promise<ProcessTableEntry[] | null> {
  if (process.platform === "win32") {
    // tree-kill's taskkill /T owns Windows; there is no session to detach into.
    return Promise.resolve(null);
  }
  if (process.platform === "linux") {
    return readLinuxProcessTable();
  }
  return readPsProcessTable();
}

async function readLinuxProcessTable(): Promise<ProcessTableEntry[] | null> {
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch {
    return null;
  }

  const entries = await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        try {
          return parseProcStat(await readFile(`/proc/${name}/stat`, "utf8"));
        } catch {
          return null;
        }
      }),
  );
  const table = entries.filter((entry): entry is ProcessTableEntry => entry !== null);
  return table.length > 0 ? table : null;
}

// /proc/<pid>/stat is "pid (comm) state ppid pgrp session ...". comm may itself
// contain spaces and parentheses, so fields are read after the last ")".
export function parseProcStat(stat: string): ProcessTableEntry | null {
  const commEnd = stat.lastIndexOf(")");
  if (commEnd === -1) return null;
  const pid = Number.parseInt(stat, 10);
  const fields = stat
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number.parseInt(fields[1] ?? "", 10);
  const session = Number.parseInt(fields[3] ?? "", 10);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(session)) {
    return null;
  }
  return { pid, ppid, sessionLeader: session === pid };
}

// BSD ps (macOS) reports no usable session id, but both BSD and procps flag a
// session leader with "s" in STAT.
function readPsProcessTable(): Promise<ProcessTableEntry[] | null> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,stat="],
      { timeout: 2_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const table = parsePsProcessTable(stdout);
        resolve(table.length > 0 ? table : null);
      },
    );
  });
}

export function parsePsProcessTable(output: string): ProcessTableEntry[] {
  const table: ProcessTableEntry[] = [];
  for (const line of output.split("\n")) {
    const [pidText, ppidText, stat = ""] = line.trim().split(/\s+/);
    const pid = Number.parseInt(pidText ?? "", 10);
    const ppid = Number.parseInt(ppidText ?? "", 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    table.push({ pid, ppid, sessionLeader: stat.includes("s") });
  }
  return table;
}

function signalDirectChild(child: TreeKillTarget, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Ignore cleanup races.
  }
}

function isProcessExited(child: TreeKillTarget): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function waitForProcessExit(child: TreeKillTarget): Promise<void> {
  if (isProcessExited(child)) {
    return Promise.resolve();
  }
  if (!child.once) {
    return new Promise(() => undefined);
  }

  return new Promise((resolve) => {
    child.once?.("exit", resolve);
  });
}

async function waitForExitOrTimeout(
  exitPromise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
