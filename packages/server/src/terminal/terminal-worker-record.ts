import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writePrivateFileAtomicSync } from "../server/private-files.js";

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
  protocolVersion: z.number().int(),
  paseoVersion: z.string(),
  socketPath: z.string().min(1),
  secret: z.string().min(1),
  terminals: z.array(TerminalWorkerTerminalEntrySchema),
  // Written by cleanup that could not confirm every process gone, with what it could not
  // confirm. A record marked closing is never adopted: the next daemon or stop retries the
  // cleanup instead.
  closing: z.object({ unresolved: z.array(TerminalCleanupUnresolvedSchema).min(1) }).optional(),
});

export type TerminalWorkerTerminalEntry = z.infer<typeof TerminalWorkerTerminalEntrySchema>;
export type TerminalCleanupUnresolved = z.infer<typeof TerminalCleanupUnresolvedSchema>;
export type TerminalWorkerRecord = z.infer<typeof TerminalWorkerRecordSchema>;

export type TerminalWorkerRecordFile =
  | { path: string; record: TerminalWorkerRecord }
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

export function terminalWorkerLogPath(paseoHome: string): string {
  return path.join(paseoHome, "terminal-worker.log");
}

export function writeTerminalWorkerRecord(paseoHome: string, record: TerminalWorkerRecord): string {
  const recordPath = terminalWorkerRecordPath(paseoHome, record.pid);
  writePrivateFileAtomicSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return recordPath;
}

export function readTerminalWorkerRecord(recordPath: string): TerminalWorkerRecord {
  return TerminalWorkerRecordSchema.parse(JSON.parse(readFileSync(recordPath, "utf8")));
}

export function listTerminalWorkerRecords(paseoHome: string): TerminalWorkerRecordFile[] {
  const directory = terminalWorkerDirectory(paseoHome);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: TerminalWorkerRecordFile[] = [];
  for (const name of names.sort()) {
    if (!/^\d+\.json$/.test(name)) continue;
    const recordPath = path.join(directory, name);
    try {
      files.push({ path: recordPath, record: readTerminalWorkerRecord(recordPath) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      files.push({
        path: recordPath,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return files;
}

/** Deletes a record and the socket it names. The pipe namespace on Windows needs no unlink. */
export function retireTerminalWorkerRecord(recordPath: string, socketPath: string | null): void {
  rmSync(recordPath, { force: true });
  if (socketPath && process.platform !== "win32") {
    rmSync(socketPath, { force: true });
  }
}
