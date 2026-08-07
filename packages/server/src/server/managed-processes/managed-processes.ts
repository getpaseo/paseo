import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { execCommand } from "../../utils/spawn.js";
import type { ProcessTerminator, TreeKillTarget } from "../../utils/tree-kill.js";

const MANAGED_PROCESS_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const MANAGED_PROCESS_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const MANAGED_PROCESS_EXIT_POLL_INTERVAL_MS = 50;
const MANAGED_PROCESS_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
// `ps -o lstart` emits a fixed-width 24-char ctime stamp, e.g. "Sat Jun 20 10:30:40 2026".
const POSIX_LSTART_WIDTH = 24;
const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

const ProcessIdentitySchema = z.object({
  commandLine: z.string().nullable(),
  startedAt: z.string().nullable(),
  // Linux /proc identity: starttime ticks since boot plus the boot id, both
  // locale-independent (unlike ps lstart).
  startTimeTicks: z.string().nullable().default(null),
  bootId: z.string().nullable().default(null),
});

const ManagedProcessDaemonSchema = z.object({
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  identity: ProcessIdentitySchema,
  bootId: z.string().nullable().default(null),
  recordedAt: z.string().min(1),
});

const ManagedProcessRecordSchema = z.object({
  id: z.string().min(1),
  owner: z.object({
    provider: z.string().min(1),
    kind: z.string().min(1),
  }),
  pid: z.number().int().positive(),
  command: z.string().min(1),
  args: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()).default({}),
  identity: ProcessIdentitySchema,
  // Identity of the daemon instance that spawned this process. Lets a reaper
  // on a shared PASEO_HOME leave another live daemon's processes alone.
  daemon: ManagedProcessDaemonSchema.optional(),
  createdAt: z.string().min(1),
});

const WindowsProcessSnapshotSchema = z.object({
  ProcessId: z.number().int().positive(),
  CommandLine: z.string().nullable().optional(),
  CreationDate: z.string().nullable().optional(),
});

export interface ManagedProcessSnapshot {
  pid: number;
  commandLine: string | null;
  startedAt: string | null;
  startTimeTicks?: string | null;
  bootId?: string | null;
}

export type ManagedProcessInspection =
  | { status: "alive"; snapshot: ManagedProcessSnapshot }
  | { status: "not-found" }
  | { status: "error"; error: unknown };

export interface ManagedProcessTable {
  inspect(pid: number): Promise<ManagedProcessInspection>;
}

export interface ManagedProcessCommandRunner {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export interface ManagedProcessOwner {
  provider: string;
  kind: string;
}

export interface ManagedProcessRecordInput {
  owner: ManagedProcessOwner;
  pid: number;
  command: string;
  args: string[];
  metadata?: Record<string, unknown>;
}

export interface ManagedProcessRecord extends ManagedProcessRecordInput {
  id: string;
  metadata: Record<string, unknown>;
  identity: {
    commandLine: string | null;
    startedAt: string | null;
    startTimeTicks?: string | null;
    bootId?: string | null;
  };
  daemon?: {
    instanceId: string;
    pid: number;
    identity: {
      commandLine: string | null;
      startedAt: string | null;
      startTimeTicks?: string | null;
      bootId?: string | null;
    };
    bootId: string | null;
    recordedAt: string;
  };
  createdAt: string;
}

export interface ManagedProcessReapResult {
  checked: number;
  dead: number;
  mismatched: number;
  removed: number;
  terminated: number;
  errors: Array<{ id: string; message: string }>;
}

export interface ManagedProcessRegistry {
  record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord>;
  remove(id: string): Promise<void>;
  updateMetadata(id: string, patch: Record<string, unknown>): Promise<void>;
  list(): Promise<ManagedProcessRecord[]>;
  reapStale(): Promise<ManagedProcessReapResult>;
}

/** Identifies the daemon instance that owns newly recorded processes. */
export interface ManagedProcessDaemonOwner {
  instanceId: string;
  pid: number;
}

/** Linux /proc reads, injectable so tests need no real procfs. */
export interface ManagedProcessProcReader {
  readStat(pid: number): Promise<string>;
  readCmdline(pid: number): Promise<string>;
  readBootId(): Promise<string>;
}

interface ManagedProcessRegistryOptions {
  paseoHome: string;
  processTable: ManagedProcessTable;
  terminateProcess: ProcessTerminator;
  logger: Logger;
  daemonOwner?: ManagedProcessDaemonOwner;
  readBootId?: () => Promise<string | null>;
}

export function createManagedProcessRegistry(
  options: ManagedProcessRegistryOptions,
): ManagedProcessRegistry {
  return new FileBackedManagedProcessRegistry(options);
}

export function createSystemManagedProcessTable(options?: {
  platform?: NodeJS.Platform;
  commandRunner?: ManagedProcessCommandRunner;
  procReader?: ManagedProcessProcReader;
}): ManagedProcessTable {
  return new SystemManagedProcessTable({
    platform: options?.platform ?? process.platform,
    commandRunner: options?.commandRunner ?? {
      exec: execCommand,
    },
    procReader: options?.procReader ?? createSystemProcReader(),
  });
}

function createSystemProcReader(): ManagedProcessProcReader {
  return {
    async readStat(pid) {
      return fs.readFile(`/proc/${pid}/stat`, "utf8");
    },
    async readCmdline(pid) {
      return fs.readFile(`/proc/${pid}/cmdline`, "utf8");
    },
    async readBootId() {
      return fs.readFile(LINUX_BOOT_ID_PATH, "utf8");
    },
  };
}

async function readSystemBootId(): Promise<string | null> {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const bootId = (await fs.readFile(LINUX_BOOT_ID_PATH, "utf8")).trim();
    return bootId || null;
  } catch {
    return null;
  }
}

/**
 * /proc/<pid>/stat field 22 (starttime, clock ticks since boot). The comm
 * field may contain spaces and parentheses, so parse relative to the last ")".
 */
export function parseProcStatStartTime(stat: string): string | null {
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) {
    return null;
  }
  const fields = stat
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/);
  // fields[0] is field 3 (state); field 22 sits at index 19.
  const startTime = fields[19];
  return startTime && /^\d+$/.test(startTime) ? startTime : null;
}

class SystemManagedProcessTable implements ManagedProcessTable {
  private readonly platform: NodeJS.Platform;
  private readonly commandRunner: ManagedProcessCommandRunner;
  private readonly procReader: ManagedProcessProcReader;

  constructor(options: {
    platform: NodeJS.Platform;
    commandRunner: ManagedProcessCommandRunner;
    procReader: ManagedProcessProcReader;
  }) {
    this.platform = options.platform;
    this.commandRunner = options.commandRunner;
    this.procReader = options.procReader;
  }

  async inspect(pid: number): Promise<ManagedProcessInspection> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { status: "not-found" };
    }

    try {
      return this.platform === "win32"
        ? await this.inspectWindows(pid)
        : await this.inspectPosix(pid);
    } catch (error) {
      return { status: "error", error };
    }
  }

  private async inspectPosix(pid: number): Promise<ManagedProcessInspection> {
    if (this.platform === "linux") {
      const procInspection = await this.inspectLinuxProc(pid);
      if (procInspection) {
        return procInspection;
      }
    }

    let stdout: string;
    try {
      // Pin the locale: `ps lstart` output is locale-dependent, and identity
      // comparison must not break because two daemons run under different
      // LC_TIME settings.
      ({ stdout } = await this.commandRunner.exec("env", [
        "LC_ALL=C",
        "LANG=C",
        "ps",
        "-ww",
        "-p",
        String(pid),
        "-o",
        "lstart=",
        "-o",
        "command=",
      ]));
    } catch (error) {
      // `ps -p <pid>` exits non-zero when no process matches the pid; a numeric
      // exit code means ps ran and found nothing, distinct from ps failing to run.
      return isCommandExitFailure(error) ? { status: "not-found" } : { status: "error", error };
    }

    const line = stdout.trimEnd();
    if (!line) {
      return { status: "not-found" };
    }

    const startedAt = line.slice(0, POSIX_LSTART_WIDTH).trim();
    const commandLine = line.slice(POSIX_LSTART_WIDTH).trim();
    return {
      status: "alive",
      snapshot: {
        pid,
        commandLine: commandLine || null,
        startedAt: startedAt || null,
      },
    };
  }

  /**
   * Locale-independent identity from /proc: start ticks since boot plus the
   * boot id. Returns null when /proc data is missing or unparsable for a
   * reason other than the process being gone, so the caller falls back to ps.
   */
  private async inspectLinuxProc(pid: number): Promise<ManagedProcessInspection | null> {
    let stat: string;
    try {
      stat = await this.procReader.readStat(pid);
    } catch (error) {
      return isNodeErrorWithCode(error, "ENOENT") ? { status: "not-found" } : null;
    }

    const startTimeTicks = parseProcStatStartTime(stat);
    if (!startTimeTicks) {
      return null;
    }

    let commandLine: string | null = null;
    try {
      const raw = await this.procReader.readCmdline(pid);
      commandLine = raw.split("\0").filter(Boolean).join(" ") || null;
    } catch {
      // Zombies and kernel threads have no cmdline; identity rests on ticks.
    }

    let bootId: string | null = null;
    try {
      bootId = (await this.procReader.readBootId()).trim() || null;
    } catch {
      // Without the boot id, tick comparison still guards PID reuse per boot.
    }

    return {
      status: "alive",
      snapshot: { pid, commandLine, startedAt: null, startTimeTicks, bootId },
    };
  }

  private async inspectWindows(pid: number): Promise<ManagedProcessInspection> {
    const command = [
      `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';`,
      "if ($process) { $process | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress }",
    ].join(" ");
    const { stdout } = await this.commandRunner.exec("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { status: "not-found" };
    }

    const parsed = WindowsProcessSnapshotSchema.parse(JSON.parse(trimmed));
    return {
      status: "alive",
      snapshot: {
        pid,
        commandLine: parsed.CommandLine ?? null,
        startedAt: parsed.CreationDate ?? null,
      },
    };
  }
}

class FileBackedManagedProcessRegistry implements ManagedProcessRegistry {
  private readonly directory: string;
  private readonly processTable: ManagedProcessTable;
  private readonly terminateProcess: ProcessTerminator;
  private readonly logger: Logger;
  private readonly daemonOwner?: ManagedProcessDaemonOwner;
  private readonly readBootId: () => Promise<string | null>;
  private daemonRecordInfo?: ManagedProcessRecord["daemon"] | null;
  private bootId?: string | null;

  constructor(options: ManagedProcessRegistryOptions) {
    this.directory = path.join(options.paseoHome, "runtime", "managed-processes");
    this.processTable = options.processTable;
    this.terminateProcess = options.terminateProcess;
    this.logger = options.logger.child({ module: "managed-processes" });
    this.daemonOwner = options.daemonOwner;
    this.readBootId = options.readBootId ?? readSystemBootId;
  }

  async record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord> {
    const inspection = await this.processTable.inspect(input.pid);
    const snapshot = inspection.status === "alive" ? inspection.snapshot : null;
    const record: ManagedProcessRecord = {
      id: randomUUID(),
      owner: input.owner,
      pid: input.pid,
      command: input.command,
      args: input.args,
      metadata: input.metadata ?? {},
      identity: {
        commandLine: snapshot?.commandLine ?? null,
        startedAt: snapshot?.startedAt ?? null,
        startTimeTicks: snapshot?.startTimeTicks ?? null,
        bootId: snapshot?.bootId ?? null,
      },
      daemon: (await this.resolveDaemonRecordInfo()) ?? undefined,
      createdAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(this.recordPath(record.id), record);
    return record;
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.recordPath(id), { force: true });
  }

  async updateMetadata(id: string, patch: Record<string, unknown>): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.recordPath(id), "utf8");
    } catch (error) {
      // The record may already be reaped; a metadata backfill is best-effort.
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    const parsed = ManagedProcessRecordSchema.parse(JSON.parse(raw));
    parsed.metadata = { ...parsed.metadata, ...patch };
    await writeJsonFileAtomic(this.recordPath(id), parsed);
  }

  private async getBootId(): Promise<string | null> {
    if (this.bootId === undefined) {
      this.bootId = await this.readBootId();
    }
    return this.bootId;
  }

  private async resolveDaemonRecordInfo(): Promise<ManagedProcessRecord["daemon"] | null> {
    if (this.daemonRecordInfo !== undefined) {
      return this.daemonRecordInfo;
    }
    const owner = this.daemonOwner;
    if (!owner) {
      this.daemonRecordInfo = null;
      return null;
    }
    const inspection = await this.processTable.inspect(owner.pid);
    const snapshot = inspection.status === "alive" ? inspection.snapshot : null;
    this.daemonRecordInfo = {
      instanceId: owner.instanceId,
      pid: owner.pid,
      identity: {
        commandLine: snapshot?.commandLine ?? null,
        startedAt: snapshot?.startedAt ?? null,
        startTimeTicks: snapshot?.startTimeTicks ?? null,
        bootId: snapshot?.bootId ?? null,
      },
      bootId: await this.getBootId(),
      recordedAt: new Date().toISOString(),
    };
    return this.daemonRecordInfo;
  }

  async list(): Promise<ManagedProcessRecord[]> {
    const entries = await this.readEntries();
    return entries.map((entry) => entry.record);
  }

  async reapStale(): Promise<ManagedProcessReapResult> {
    const result: ManagedProcessReapResult = {
      checked: 0,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
      errors: [],
    };

    for (const entry of await this.readEntries()) {
      result.checked += 1;
      try {
        if (entry.record.daemon) {
          const ownerStatus = await this.classifyDaemonOwner(entry.record.daemon);
          if (ownerStatus === "alive") {
            // Another live daemon on this PASEO_HOME owns the process; leave
            // both the record and the process alone.
            continue;
          }
          if (ownerStatus === "unknown") {
            result.errors.push({
              id: entry.record.id,
              message: "Could not verify daemon owner identity; leaving record for next reconcile",
            });
            continue;
          }
        }

        const inspection = await this.processTable.inspect(entry.record.pid);
        if (inspection.status === "not-found") {
          await fs.rm(entry.path, { force: true });
          result.dead += 1;
          result.removed += 1;
          continue;
        }

        if (inspection.status === "error") {
          // Inspection failed, so we cannot tell whether the helper is still
          // alive. Keep the record and retry on the next reconcile rather than
          // orphaning a live process by deleting its record without killing it.
          const message =
            inspection.error instanceof Error ? inspection.error.message : String(inspection.error);
          result.errors.push({ id: entry.record.id, message });
          this.logger.warn(
            {
              err: inspection.error,
              id: entry.record.id,
              pid: entry.record.pid,
              owner: entry.record.owner,
            },
            "Could not inspect managed helper process; leaving record for next reconcile",
          );
          continue;
        }

        const snapshot = inspection.snapshot;
        if (!processIdentityMatches(entry.record, snapshot)) {
          await fs.rm(entry.path, { force: true });
          result.mismatched += 1;
          result.removed += 1;
          continue;
        }

        await this.terminateProcess(createPidTarget(entry.record.pid), {
          gracefulTimeoutMs: MANAGED_PROCESS_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
          forceTimeoutMs: MANAGED_PROCESS_FORCE_SHUTDOWN_TIMEOUT_MS,
          onForceSignal: () => {
            this.logger.warn(
              {
                pid: entry.record.pid,
                owner: entry.record.owner,
                timeoutMs: MANAGED_PROCESS_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
              },
              "Managed helper process did not exit after SIGTERM; sending SIGKILL",
            );
          },
        });
        await fs.rm(entry.path, { force: true });
        result.terminated += 1;
        result.removed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({ id: entry.record.id, message });
        this.logger.warn(
          { err: error, id: entry.record.id, pid: entry.record.pid, owner: entry.record.owner },
          "Failed to reap managed helper process",
        );
      }
    }

    return result;
  }

  /**
   * Decide whether the daemon that recorded a process is still its live
   * owner. A child is only reaped when the owner is gone: the owner pid is
   * dead, the pid was reused by an unrelated process, or the record predates
   * the current boot. Any uncertainty keeps the record untouched.
   */
  private async classifyDaemonOwner(
    daemon: NonNullable<ManagedProcessRecord["daemon"]>,
  ): Promise<"alive" | "stale" | "unknown"> {
    const currentBootId = await this.getBootId();
    if (daemon.bootId && currentBootId && daemon.bootId !== currentBootId) {
      return "stale";
    }

    const inspection = await this.processTable.inspect(daemon.pid);
    if (inspection.status === "not-found") {
      return "stale";
    }
    if (inspection.status === "error") {
      return "unknown";
    }

    const identity = daemon.identity;
    const snapshot = inspection.snapshot;
    if (identity.startTimeTicks && snapshot.startTimeTicks) {
      if (identity.bootId && snapshot.bootId && identity.bootId !== snapshot.bootId) {
        return "stale";
      }
      return identity.startTimeTicks === snapshot.startTimeTicks ? "alive" : "stale";
    }
    if (identity.startedAt && snapshot.startedAt) {
      return identity.startedAt === snapshot.startedAt ? "alive" : "stale";
    }
    return "unknown";
  }

  private recordPath(id: string): string {
    if (!MANAGED_PROCESS_ID_PATTERN.test(id)) {
      throw new Error(`Invalid managed process record id: ${id}`);
    }
    return path.join(this.directory, `${id}.json`);
  }

  private async readEntries(): Promise<Array<{ path: string; record: ManagedProcessRecord }>> {
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.directory);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }

    const entries: Array<{ path: string; record: ManagedProcessRecord }> = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(this.directory, fileName);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = ManagedProcessRecordSchema.parse(JSON.parse(raw));
        entries.push({ path: filePath, record: parsed });
      } catch (error) {
        // A single corrupt or partially-written record must not abort the whole
        // reconcile and leave every other leftover un-reaped. Skip it.
        this.logger.warn(
          { err: error, file: fileName },
          "Skipping unreadable managed process record",
        );
      }
    }
    return entries;
  }
}

function processIdentityMatches(
  record: ManagedProcessRecord,
  snapshot: ManagedProcessSnapshot,
): boolean {
  if (record.identity.startTimeTicks && snapshot.startTimeTicks) {
    if (record.identity.bootId && snapshot.bootId && record.identity.bootId !== snapshot.bootId) {
      return false;
    }
    // Equal start ticks on the same boot identify the process even when it
    // rewrote its command line; different ticks mean the PID was reused.
    return record.identity.startTimeTicks === snapshot.startTimeTicks;
  }

  if (record.identity.startedAt && snapshot.startedAt) {
    if (record.identity.startedAt !== snapshot.startedAt) {
      return false;
    }
    // Agents that rewrite their process title (e.g. kimi shows up as
    // "kimi-cod", not "kimi acp") never match the command-signature check.
    // A matching start timestamp plus exact equality with the command line
    // captured at record time is still strong identity evidence.
    if (
      record.identity.commandLine &&
      snapshot.commandLine &&
      normalizeCommandLine(record.identity.commandLine) ===
        normalizeCommandLine(snapshot.commandLine)
    ) {
      return true;
    }
    return snapshot.commandLine ? commandLineMatchesRecord(record, snapshot.commandLine) : true;
  }

  if (record.identity.commandLine && snapshot.commandLine) {
    return (
      normalizeCommandLine(record.identity.commandLine) ===
      normalizeCommandLine(snapshot.commandLine)
    );
  }

  return snapshot.commandLine ? commandLineMatchesRecord(record, snapshot.commandLine) : false;
}

function commandLineMatchesRecord(record: ManagedProcessRecord, commandLine: string): boolean {
  // Require the command name and args as one contiguous run, not scattered
  // tokens. Without exact process identity (lstart), a reused PID whose command
  // line merely mentions "opencode", "serve" and the port elsewhere must not be
  // mistaken for our leftover and killed.
  const normalized = normalizeCommandLine(commandLine);
  const commandName = path.basename(record.command).toLowerCase();
  const signature = [commandName, ...record.args].map((token) => token.toLowerCase()).join(" ");
  return normalized.includes(signature);
}

function normalizeCommandLine(commandLine: string): string {
  return commandLine.replace(/\s+/g, " ").trim().toLowerCase();
}

export function createPidTarget(pid: number): TreeKillTarget {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill(signal?: NodeJS.Signals | number) {
      process.kill(pid, signal);
      return true;
    },
    // The reaper has no ChildProcess handle for a leftover from a previous
    // daemon, so it observes exit by polling the pid. Without this, termination
    // can never see a graceful SIGTERM exit and always waits out the full
    // graceful+force window before escalating to SIGKILL.
    once(_event, listener) {
      const timer = setInterval(() => {
        if (!isProcessAlive(pid)) {
          clearInterval(timer);
          listener();
        }
      }, MANAGED_PROCESS_EXIT_POLL_INTERVAL_MS);
      timer.unref();
    },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeErrorWithCode(error, "EPERM");
  }
}

function isCommandExitFailure(error: unknown): boolean {
  // execFile rejects with a numeric `code` (the process exit status) when the
  // command ran and exited non-zero; a string `code` (e.g. "ENOENT") means it
  // never ran.
  return typeof (error as { code?: unknown })?.code === "number";
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
