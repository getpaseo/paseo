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
export const MANAGED_PROCESS_IDENTITY_ENV = "PASEO_MANAGED_PROCESS_TOKEN";
// `ps -o lstart` emits a fixed-width 24-char ctime stamp, e.g. "Sat Jun 20 10:30:40 2026".
const POSIX_LSTART_WIDTH = 24;

const ManagedProcessLifecycleSchema = z.object({
  execTransition: z.enum(["none", "pending", "confirmed"]),
  terminationScope: z.enum(["process", "process-group"]),
});

const DEFAULT_MANAGED_PROCESS_LIFECYCLE: ManagedProcessLifecycle = {
  execTransition: "none",
  terminationScope: "process",
};

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
  lifecycle: ManagedProcessLifecycleSchema.default(DEFAULT_MANAGED_PROCESS_LIFECYCLE),
  identity: z.object({
    commandLine: z.string().nullable(),
    startedAt: z.string().nullable(),
    token: z.string().nullable().default(null),
  }),
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
  token?: string | null;
}

export type ManagedProcessInspection =
  | { status: "alive"; snapshot: ManagedProcessSnapshot }
  | { status: "not-found" }
  | { status: "error"; error: unknown };

export type ManagedProcessGroupInspection =
  | { status: "owned" }
  | { status: "not-found" }
  | { status: "unverifiable"; message: string }
  | { status: "error"; error: unknown };

export interface ManagedProcessTable {
  inspect(pid: number): Promise<ManagedProcessInspection>;
  inspectProcessGroup(
    processGroupId: number,
    identityToken: string | null,
  ): Promise<ManagedProcessGroupInspection>;
}

export interface ManagedProcessCommandRunner {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export interface ManagedProcessOwner {
  provider: string;
  kind: string;
}

export type ManagedProcessLifecycle = z.infer<typeof ManagedProcessLifecycleSchema>;

export interface ManagedProcessRecordInput {
  owner: ManagedProcessOwner;
  pid: number;
  command: string;
  args: string[];
  metadata?: Record<string, unknown>;
  lifecycle?: ManagedProcessLifecycle;
  identityToken?: string;
}

export interface ManagedProcessRecord extends Omit<
  ManagedProcessRecordInput,
  "identityToken" | "lifecycle"
> {
  id: string;
  metadata: Record<string, unknown>;
  lifecycle: ManagedProcessLifecycle;
  identity: {
    commandLine: string | null;
    startedAt: string | null;
    token: string | null;
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

export interface ManagedProcessReapOptions {
  recordIds?: ReadonlySet<string>;
  signal?: AbortSignal;
}

export interface ManagedProcessListOptions {
  signal?: AbortSignal;
}

export interface ManagedProcessRegistry {
  record(
    input: ManagedProcessRecordInput,
    options?: { onIdentityCaptured?: (record: ManagedProcessRecord) => void },
  ): Promise<ManagedProcessRecord>;
  retain(record: ManagedProcessRecord): Promise<void>;
  confirmExecTransition(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  list(options?: ManagedProcessListOptions): Promise<ManagedProcessRecord[]>;
  reapStale(options?: ManagedProcessReapOptions): Promise<ManagedProcessReapResult>;
}

interface ManagedProcessRegistryOptions {
  paseoHome: string;
  processTable: ManagedProcessTable;
  terminateProcess: ProcessTerminator;
  logger: Logger;
  writeRecord?: (filePath: string, record: ManagedProcessRecord) => Promise<void>;
}

export function createManagedProcessRegistry(
  options: ManagedProcessRegistryOptions,
): ManagedProcessRegistry {
  return new FileBackedManagedProcessRegistry(options);
}

export function createSystemManagedProcessTable(options?: {
  platform?: NodeJS.Platform;
  commandRunner?: ManagedProcessCommandRunner;
}): ManagedProcessTable {
  return new SystemManagedProcessTable({
    platform: options?.platform ?? process.platform,
    commandRunner: options?.commandRunner ?? {
      exec: execCommand,
    },
  });
}

export async function inspectSystemProcessGroupIdentity(
  processGroupId: number,
  identityToken: string,
): Promise<ManagedProcessGroupInspection> {
  return createSystemManagedProcessTable().inspectProcessGroup(processGroupId, identityToken);
}

export async function verifySystemManagedProcessIdentity(
  record: ManagedProcessRecord,
): Promise<boolean> {
  const inspection = await createSystemManagedProcessTable().inspect(record.pid);
  return (
    inspection.status === "alive" &&
    inspectProcessIdentity(record, inspection.snapshot).status === "owned"
  );
}

class SystemManagedProcessTable implements ManagedProcessTable {
  private readonly platform: NodeJS.Platform;
  private readonly commandRunner: ManagedProcessCommandRunner;

  constructor(options: { platform: NodeJS.Platform; commandRunner: ManagedProcessCommandRunner }) {
    this.platform = options.platform;
    this.commandRunner = options.commandRunner;
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

  async inspectProcessGroup(
    processGroupId: number,
    identityToken: string | null,
  ): Promise<ManagedProcessGroupInspection> {
    if (this.platform === "win32" || !Number.isInteger(processGroupId) || processGroupId <= 0) {
      return { status: "not-found" };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let stdout: string;
      try {
        ({ stdout } = await this.commandRunner.exec("ps", ["-ax", "-o", "pid=", "-o", "pgid="]));
      } catch (error) {
        return { status: "error", error };
      }
      const memberPids = parseProcessGroupMemberPids(stdout, processGroupId);
      if (memberPids.length === 0) {
        return { status: "not-found" };
      }
      if (!identityToken) {
        return {
          status: "unverifiable",
          message: "managed process group identity token was not recorded",
        };
      }

      let inspectionError: unknown;
      let inspectedLiveMember = false;
      for (const pid of memberPids) {
        const inspection = await this.inspect(pid);
        if (inspection.status === "error") {
          inspectionError ??= inspection.error;
          continue;
        }
        if (inspection.status === "alive") {
          inspectedLiveMember = true;
          if (inspection.snapshot.token === identityToken) {
            return { status: "owned" };
          }
        }
      }
      if (inspectedLiveMember) {
        return {
          status: "unverifiable",
          message: "managed process group identity token is unavailable from its members",
        };
      }
      if (attempt === 1 && inspectionError) {
        return { status: "error", error: inspectionError };
      }
    }
    return { status: "not-found" };
  }

  private async inspectPosix(pid: number): Promise<ManagedProcessInspection> {
    let stdout: string;
    try {
      ({ stdout } = await this.commandRunner.exec("ps", [
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
    let environmentOutput: string;
    try {
      ({ stdout: environmentOutput } = await this.commandRunner.exec("ps", [
        "eww",
        "-p",
        String(pid),
        "-o",
        "command=",
      ]));
    } catch (error) {
      return isCommandExitFailure(error) ? { status: "not-found" } : { status: "error", error };
    }
    return {
      status: "alive",
      snapshot: {
        pid,
        commandLine: commandLine || null,
        startedAt: startedAt || null,
        token: extractIdentityToken(environmentOutput),
      },
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
  private readonly writeRecord: (filePath: string, record: ManagedProcessRecord) => Promise<void>;
  private readonly recordOperations = new Map<string, Promise<void>>();

  constructor(options: ManagedProcessRegistryOptions) {
    this.directory = path.join(options.paseoHome, "runtime", "managed-processes");
    this.processTable = options.processTable;
    this.terminateProcess = options.terminateProcess;
    this.logger = options.logger.child({ module: "managed-processes" });
    this.writeRecord = options.writeRecord ?? writeJsonFileAtomic;
  }

  async record(
    input: ManagedProcessRecordInput,
    options?: { onIdentityCaptured?: (record: ManagedProcessRecord) => void },
  ): Promise<ManagedProcessRecord> {
    const inspection = await this.processTable.inspect(input.pid);
    if (inspection.status !== "alive") {
      const detail =
        inspection.status === "error" ? errorMessage(inspection.error) : "process not found";
      throw new Error(`Cannot record managed process identity: ${detail}`);
    }
    const snapshot = inspection.snapshot;
    if (!snapshot.commandLine || !snapshot.startedAt) {
      throw new Error("Cannot record managed process without command and start-time identity");
    }
    if (input.identityToken && snapshot.token !== input.identityToken) {
      throw new Error("Cannot record managed process without its identity token");
    }
    const record: ManagedProcessRecord = {
      id: randomUUID(),
      owner: input.owner,
      pid: input.pid,
      command: input.command,
      args: input.args,
      metadata: input.metadata ?? {},
      lifecycle: input.lifecycle ?? DEFAULT_MANAGED_PROCESS_LIFECYCLE,
      identity: {
        commandLine: snapshot.commandLine,
        startedAt: snapshot.startedAt,
        token: input.identityToken ?? null,
      },
      createdAt: new Date().toISOString(),
    };

    options?.onIdentityCaptured?.(record);
    await this.retain(record);
    return record;
  }

  async retain(record: ManagedProcessRecord): Promise<void> {
    await this.withRecordLock(record.id, () =>
      this.writeRecord(this.recordPath(record.id), record),
    );
  }

  async remove(id: string): Promise<void> {
    await this.withRecordLock(id, () => fs.rm(this.recordPath(id), { force: true }));
  }

  async confirmExecTransition(id: string): Promise<void> {
    await this.withRecordLock(id, () => this.confirmExecTransitionUnlocked(id));
  }

  private async confirmExecTransitionUnlocked(id: string): Promise<void> {
    const entry = (await this.readEntries()).find((candidate) => candidate.record.id === id);
    if (!entry) {
      throw new Error(`Managed process record not found: ${id}`);
    }
    if (entry.record.lifecycle.execTransition !== "pending") {
      return;
    }

    const inspection = await this.processTable.inspect(entry.record.pid);
    if (inspection.status !== "alive") {
      const detail =
        inspection.status === "error" ? errorMessage(inspection.error) : "process not found";
      throw new Error(`Cannot confirm managed process exec transition: ${detail}`);
    }
    const startedAt = entry.record.identity.startedAt;
    if (
      !startedAt ||
      !inspection.snapshot.startedAt ||
      startedAt !== inspection.snapshot.startedAt
    ) {
      throw new Error("Cannot confirm managed process exec transition without matching start time");
    }
    if (entry.record.identity.token && entry.record.identity.token !== inspection.snapshot.token) {
      throw new Error("Cannot confirm managed process exec transition without its identity token");
    }
    if (!inspection.snapshot.commandLine) {
      throw new Error("Cannot confirm managed process exec transition without a command line");
    }

    await this.writeRecord(entry.path, {
      ...entry.record,
      lifecycle: { ...entry.record.lifecycle, execTransition: "confirmed" },
      identity: { ...entry.record.identity, commandLine: inspection.snapshot.commandLine },
    });
  }

  async list(options: ManagedProcessListOptions = {}): Promise<ManagedProcessRecord[]> {
    const entries = await this.readEntries(options);
    options.signal?.throwIfAborted();
    return entries.map((entry) => entry.record);
  }

  async reapStale(options: ManagedProcessReapOptions = {}): Promise<ManagedProcessReapResult> {
    const result: ManagedProcessReapResult = {
      checked: 0,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
      errors: [],
    };

    throwIfAborted(options.signal);
    const entries = await this.readEntries(options);
    for (const entry of entries) {
      throwIfAborted(options.signal);
      if (!includesRecord(options.recordIds, entry.record.id)) {
        continue;
      }
      result.checked += 1;
      try {
        const inspection = await this.processTable.inspect(entry.record.pid);
        throwIfAborted(options.signal);
        let identityOwned = false;
        if (inspection.status === "not-found") {
          const groupInspection = await inspectLeaderlessProcessGroup(
            this.processTable,
            entry.record,
          );
          throwIfAborted(options.signal);
          if (groupInspection.status === "owned") {
            identityOwned = true;
          } else if (groupInspection.status !== "not-found") {
            const message =
              groupInspection.status === "error"
                ? errorMessage(groupInspection.error)
                : groupInspection.message;
            result.errors.push({ id: entry.record.id, message });
            this.logger.warn(
              { id: entry.record.id, pid: entry.record.pid, owner: entry.record.owner },
              `${message}; leaving record for next reconcile`,
            );
            continue;
          } else {
            throwIfAborted(options.signal);
            await this.remove(entry.record.id);
            result.dead += 1;
            result.removed += 1;
            continue;
          }
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

        if (!identityOwned && inspection.status === "alive") {
          const identity = inspectProcessIdentity(entry.record, inspection.snapshot);
          if (identity.status === "unrelated") {
            throwIfAborted(options.signal);
            await this.remove(entry.record.id);
            result.mismatched += 1;
            result.removed += 1;
            continue;
          }

          if (identity.status === "unverifiable") {
            result.errors.push({ id: entry.record.id, message: identity.message });
            this.logger.warn(
              { id: entry.record.id, pid: entry.record.pid, owner: entry.record.owner },
              `${identity.message}; leaving record for next reconcile`,
            );
            continue;
          }
        }

        const termination = await this.terminateProcess(createTerminationTarget(entry.record), {
          gracefulTimeoutMs: MANAGED_PROCESS_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
          forceTimeoutMs: MANAGED_PROCESS_FORCE_SHUTDOWN_TIMEOUT_MS,
          preserveRootOnTreeFailure: true,
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
          beforeSignal: () => verifyManagedProcessIdentity(this.processTable, entry.record),
          signal: options.signal,
        });
        throwIfAborted(options.signal);
        if (termination === "signal-skipped") {
          result.errors.push({
            id: entry.record.id,
            message: "managed process identity changed before a cleanup signal",
          });
          continue;
        }
        if (termination === "kill-timeout") {
          const target =
            entry.record.lifecycle.terminationScope === "process-group"
              ? "managed process group"
              : "managed process";
          result.errors.push({
            id: entry.record.id,
            message: `${target} did not exit after SIGKILL`,
          });
          continue;
        }
        throwIfAborted(options.signal);
        await this.remove(entry.record.id);
        result.terminated += 1;
        result.removed += 1;
      } catch (error) {
        if (isAborted(options.signal)) {
          throw error;
        }
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

  private recordPath(id: string): string {
    if (!MANAGED_PROCESS_ID_PATTERN.test(id)) {
      throw new Error(`Invalid managed process record id: ${id}`);
    }
    return path.join(this.directory, `${id}.json`);
  }

  private async withRecordLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.recordOperations.get(id) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.recordOperations.set(id, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.recordOperations.get(id) === queued) {
        this.recordOperations.delete(id);
      }
    }
  }

  private async readEntries(
    options: ManagedProcessListOptions = {},
  ): Promise<Array<{ path: string; record: ManagedProcessRecord }>> {
    options.signal?.throwIfAborted();
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.directory);
      options.signal?.throwIfAborted();
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }

    const entries: Array<{ path: string; record: ManagedProcessRecord }> = [];
    for (const fileName of fileNames) {
      options.signal?.throwIfAborted();
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(this.directory, fileName);
      try {
        const raw = await fs.readFile(filePath, {
          encoding: "utf8",
          signal: options.signal,
        });
        options.signal?.throwIfAborted();
        const parsed = ManagedProcessRecordSchema.parse(JSON.parse(raw));
        entries.push({ path: filePath, record: parsed });
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
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

type ManagedProcessIdentity =
  | { status: "owned" }
  | { status: "unrelated" }
  | { status: "unverifiable"; message: string };

function inspectProcessIdentity(
  record: ManagedProcessRecord,
  snapshot: ManagedProcessSnapshot,
): ManagedProcessIdentity {
  if (record.identity.token) {
    if (!snapshot.token) {
      return { status: "unverifiable", message: "managed process identity token is unavailable" };
    }
    if (record.identity.token !== snapshot.token) {
      return { status: "unrelated" };
    }
  }
  if (!record.identity.startedAt) {
    return { status: "unverifiable", message: "managed process start time was not recorded" };
  }
  if (!snapshot.startedAt) {
    return { status: "unverifiable", message: "managed process start time is unavailable" };
  }
  if (record.identity.startedAt !== snapshot.startedAt) {
    return { status: "unrelated" };
  }
  if (!record.identity.commandLine || !snapshot.commandLine) {
    return { status: "unverifiable", message: "managed process command line is unavailable" };
  }
  if (
    normalizeCommandLine(record.identity.commandLine) !== normalizeCommandLine(snapshot.commandLine)
  ) {
    if (record.lifecycle.execTransition === "pending" && record.identity.token) {
      return { status: "owned" };
    }
    return {
      status: "unverifiable",
      message: "managed process command does not match its captured identity",
    };
  }
  return { status: "owned" };
}

function normalizeCommandLine(commandLine: string): string {
  return commandLine.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractIdentityToken(output: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)${MANAGED_PROCESS_IDENTITY_ENV}=([^\\s]+)`);
  return output.match(pattern)?.[1] ?? null;
}

function parseProcessGroupMemberPids(output: string, processGroupId: number): number[] {
  const memberPids: number[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (match && Number(match[2]) === processGroupId) {
      memberPids.push(Number(match[1]));
    }
  }
  return memberPids;
}

async function inspectLeaderlessProcessGroup(
  processTable: ManagedProcessTable,
  record: ManagedProcessRecord,
): Promise<ManagedProcessGroupInspection> {
  if (record.lifecycle.terminationScope !== "process-group") {
    return { status: "not-found" };
  }
  return processTable.inspectProcessGroup(record.pid, record.identity.token);
}

async function verifyManagedProcessIdentity(
  processTable: ManagedProcessTable,
  record: ManagedProcessRecord,
): Promise<boolean> {
  if (record.lifecycle.terminationScope === "process-group") {
    const inspection = await processTable.inspectProcessGroup(record.pid, record.identity.token);
    return inspection.status === "owned";
  }

  const inspection = await processTable.inspect(record.pid);
  return (
    inspection.status === "alive" &&
    inspectProcessIdentity(record, inspection.snapshot).status === "owned"
  );
}

export function createPidTarget(pid: number): TreeKillTarget {
  return createPollingTarget(pid);
}

function createTerminationTarget(record: ManagedProcessRecord): TreeKillTarget {
  return record.lifecycle.terminationScope === "process-group"
    ? createProcessGroupTarget(record.pid)
    : createPidTarget(record.pid);
}

export function createProcessGroupTarget(processGroupId: number): TreeKillTarget {
  return createPollingTarget(-processGroupId);
}

function createPollingTarget(signalTarget: number): TreeKillTarget {
  return {
    pid: signalTarget,
    exitCode: null,
    signalCode: null,
    kill(signal?: NodeJS.Signals | number) {
      process.kill(signalTarget, signal);
      return true;
    },
    // The reaper has no ChildProcess handle for a leftover from a previous
    // daemon, so it observes exit by polling the pid. Without this, termination
    // can never see a graceful SIGTERM exit and always waits out the full
    // graceful+force window before escalating to SIGKILL.
    observeExit(listener) {
      const timer = setInterval(() => {
        if (!isProcessAlive(signalTarget)) {
          clearInterval(timer);
          listener();
        }
      }, MANAGED_PROCESS_EXIT_POLL_INTERVAL_MS);
      timer.unref();
      return () => clearInterval(timer);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function includesRecord(recordIds: ReadonlySet<string> | undefined, id: string): boolean {
  return recordIds === undefined || recordIds.has(id);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
