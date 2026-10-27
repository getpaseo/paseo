import { readdir, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { z } from "zod";
import { writePrivateFileAtomicSync, writePrivateFileAtomic } from "../server/private-files.js";

// Owner-only metadata a detached terminal worker leaves in $PASEO_HOME so the next daemon can
// find, authenticate and adopt it, and so cleanup can identify every process it is allowed to
// signal. Process identity is the birth time `ps`/Win32_Process report, never the pid alone.

const TerminalWorkerTerminalEntrySchema = z.object({
  id: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
});

// One process a cleanup could not confirm gone, kept so a later caller (a retry, or a remote
// client reading daemon status) can name it.
const TerminalCleanupUnresolvedSchema = z.object({
  pid: z.number().int().positive(),
  role: z.enum(["worker", "terminal program"]),
  reason: z.enum(["still alive", "inspection failed"]),
  detail: z.string(),
});

const TerminalWorkerRecordSchema = z.object({
  recordId: z.string().min(1),
  pid: z.number().int().positive(),
  bootId: z.string().nullable(),
  createdAt: z.string().min(1),
  identity: z.object({
    startedAt: z.string().min(1),
    commandLine: z.string().min(1),
  }),
  // Read loosely: a version this daemon cannot interpret marks a worker from a newer Paseo
  // (classifyTerminalWorkerProtocol), not an unreadable record.
  protocolVersion: z.union([z.number(), z.string()]),
  paseoVersion: z.string(),
  socketPath: z.string().min(1),
  secret: z.string().min(1),
  // The copy of the worker's files it runs from (a directory name under terminal-worker/), or
  // null when it runs from source. A copy named by any record is never deleted.
  runtime: z.string().nullable().optional(),
  terminals: z.array(TerminalWorkerTerminalEntrySchema),
  // Set only in a cleanup record (below), with what a cleanup could not confirm gone. A record
  // marked closing is never adopted: the next daemon or stop retries the cleanup instead.
  closing: z.object({ unresolved: z.array(TerminalCleanupUnresolvedSchema).min(1) }).optional(),
});

export type TerminalWorkerTerminalEntry = z.infer<typeof TerminalWorkerTerminalEntrySchema>;
export type TerminalCleanupUnresolved = z.infer<typeof TerminalCleanupUnresolvedSchema>;
export type TerminalWorkerRecord = z.infer<typeof TerminalWorkerRecordSchema>;

// A worker record (`<pid>.json`) belongs to the worker, which rewrites it from memory whenever
// a terminal starts or exits. A cleanup that cannot confirm every process gone therefore keeps
// its state in a cleanup record of its own (`closing-<recordId>.json`) that no worker writes, so
// the kill intent and what it could not confirm survive any later worker rewrite.
type TerminalWorkerRecordKind = "worker" | "cleanup";

export type TerminalWorkerRecordFile =
  | {
      // The file holding this record's state: the cleanup record when there is one.
      path: string;
      record: TerminalWorkerRecord;
      // The worker's own record file, when it still exists.
      workerRecordPath: string | null;
    }
  | { path: string; error: Error };

// The worker's command line carries this marker followed by its record id, so a reused pid
// running some other process (even another worker) never matches the record.
export const TERMINAL_WORKER_MARKER_ARG = "--paseo-terminal-worker";

export function terminalWorkerDirectory(paseoHome: string): string {
  return path.join(paseoHome, "terminal-worker");
}

export function terminalWorkerRecordPath(paseoHome: string, workerPid: number): string {
  return path.join(terminalWorkerDirectory(paseoHome), `${workerPid}.json`);
}

export function terminalCleanupRecordPath(paseoHome: string, recordId: string): string {
  return path.join(terminalWorkerDirectory(paseoHome), `closing-${recordId}.json`);
}

export function terminalWorkerLogPath(paseoHome: string): string {
  return path.join(paseoHome, "terminal-worker.log");
}

export function writeTerminalWorkerRecord(paseoHome: string, record: TerminalWorkerRecord): string {
  const recordPath = terminalWorkerRecordPath(paseoHome, record.pid);
  writePrivateFileAtomicSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return recordPath;
}

/** Writes the state of a cleanup that could not confirm every process gone. */
export async function writeTerminalCleanupRecord(
  paseoHome: string,
  record: TerminalWorkerRecord & { closing: NonNullable<TerminalWorkerRecord["closing"]> },
): Promise<string> {
  if (!RECORD_ID_PATTERN.test(record.recordId)) {
    throw new Error(`Terminal worker record id is not a file name: ${record.recordId}`);
  }
  const recordPath = terminalCleanupRecordPath(paseoHome, record.recordId);
  await writePrivateFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return recordPath;
}

export async function readTerminalWorkerRecord(recordPath: string): Promise<TerminalWorkerRecord> {
  return TerminalWorkerRecordSchema.parse(JSON.parse(await readRecordFile(recordPath)));
}

// A worker rewrites its record by renaming a new file over it. On Windows an open() that races
// that rename fails with EPERM (or EBUSY) for a moment, so such an error is retried for a short
// window before the record counts as unreadable. Reads and retries yield so daemon status and
// cleanup never block unrelated requests while another process holds the record open.
const TRANSIENT_READ_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);
const TRANSIENT_READ_WINDOW_MS = 250;
const TRANSIENT_READ_PAUSE_MS = 10;

async function readRecordFile(recordPath: string): Promise<string> {
  const deadline = Date.now() + TRANSIENT_READ_WINDOW_MS;
  for (;;) {
    try {
      return await readFile(recordPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_READ_ERRORS.has(code) || Date.now() >= deadline) throw error;
      await delay(TRANSIENT_READ_PAUSE_MS);
    }
  }
}

const RECORD_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const WORKER_RECORD_NAME = /^\d+\.json$/;
const CLEANUP_RECORD_NAME = /^closing-[A-Za-z0-9-]+\.json$/;

function recordKindOf(fileName: string): TerminalWorkerRecordKind | null {
  if (WORKER_RECORD_NAME.test(fileName)) return "worker";
  if (CLEANUP_RECORD_NAME.test(fileName)) return "cleanup";
  return null;
}

/**
 * Every record in the home. A cleanup record is merged with the worker record of the same
 * record id: its closing state wins, and terminals the worker recorded since join it, so the
 * retry covers everything the worker still runs.
 */
export async function listTerminalWorkerRecords(
  paseoHome: string,
): Promise<TerminalWorkerRecordFile[]> {
  const directory = terminalWorkerDirectory(paseoHome);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const errors: TerminalWorkerRecordFile[] = [];
  const workers: Array<{ path: string; record: TerminalWorkerRecord }> = [];
  const cleanups: Array<{ path: string; record: TerminalWorkerRecord }> = [];
  for (const name of names.sort()) {
    const kind = recordKindOf(name);
    if (!kind) continue;
    const recordPath = path.join(directory, name);
    try {
      const record = await readTerminalWorkerRecord(recordPath);
      (kind === "worker" ? workers : cleanups).push({ path: recordPath, record });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      errors.push({
        path: recordPath,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  const files: TerminalWorkerRecordFile[] = [];
  const merged = new Set<string>();
  for (const cleanup of cleanups) {
    const worker = workers.find(
      (entry) =>
        entry.record.recordId === cleanup.record.recordId &&
        entry.record.pid === cleanup.record.pid,
    );
    if (worker) merged.add(worker.path);
    const known = new Set(cleanup.record.terminals.map((entry) => `${entry.id}:${entry.pid}`));
    const added = (worker?.record.terminals ?? []).filter(
      (entry) => !known.has(`${entry.id}:${entry.pid}`),
    );
    files.push({
      path: cleanup.path,
      record: { ...cleanup.record, terminals: [...cleanup.record.terminals, ...added] },
      workerRecordPath: worker?.path ?? null,
    });
  }
  for (const worker of workers) {
    if (merged.has(worker.path)) continue;
    files.push({ path: worker.path, record: worker.record, workerRecordPath: worker.path });
  }
  return [...files, ...errors];
}

/**
 * Deletes a record, the worker's own record file and the socket it names, unless a later worker
 * that reused the pid wrote that file since. The pipe namespace on Windows needs no unlink.
 */
export async function retireTerminalWorkerRecord(file: {
  path: string;
  record: TerminalWorkerRecord;
  workerRecordPath: string | null;
}): Promise<void> {
  if (file.path !== file.workerRecordPath) await rm(file.path, { force: true });
  if (file.workerRecordPath) {
    if (await workerRecordNamesAnother(file.workerRecordPath, file.record.recordId)) return;
    await rm(file.workerRecordPath, { force: true });
  }
  if (process.platform !== "win32") {
    await rm(file.record.socketPath, { force: true });
  }
}

// True when the file now belongs to another worker, or cannot be read to tell.
async function workerRecordNamesAnother(recordPath: string, recordId: string): Promise<boolean> {
  try {
    return (await readTerminalWorkerRecord(recordPath)).recordId !== recordId;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
