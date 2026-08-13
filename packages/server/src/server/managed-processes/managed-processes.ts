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
const WINDOWS_PROVISIONAL_IDENTITY_WINDOW_MS = 5 * 60 * 1_000;
export const MANAGED_PROCESS_OWNERSHIP_TOKEN_ENV = "PASEO_HELPER_OWNERSHIP_TOKEN";
// `ps -o lstart` emits a fixed-width 24-char ctime stamp, e.g. "Sat Jun 20 10:30:40 2026".
const POSIX_LSTART_WIDTH = 24;

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
  identity: z.object({
    commandLine: z.string().nullable(),
    startedAt: z.string().nullable(),
    ownershipToken: z.string().nullable().optional(),
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
  ownershipToken?: string | null;
}

export type ManagedProcessInspection =
  | { status: "alive"; snapshot: ManagedProcessSnapshot }
  | { status: "not-found" }
  | { status: "error"; error: unknown };

export interface ManagedProcessTable {
  inspect(pid: number): Promise<ManagedProcessInspection>;
  inspectProcessGroup(
    processGroupId: number,
    ownershipToken: string | null,
  ): Promise<ManagedProcessVerification>;
  findOwnedProcessIds(ownershipToken: string): Promise<number[] | null>;
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
  ownershipToken?: string;
}

export interface ManagedProcessRecord extends ManagedProcessRecordInput {
  id: string;
  metadata: Record<string, unknown>;
  identity: {
    commandLine: string | null;
    startedAt: string | null;
    ownershipToken?: string | null;
  };
  createdAt: string;
}

export interface ManagedProcessGroupIdentity {
  processGroupId: number;
  ownershipToken: string;
}

export interface ManagedProcessRecordOptions {
  onIdentityCaptured?: (record: ManagedProcessRecord) => void;
  onRecordPersisted?: (record: ManagedProcessRecord) => void;
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
  record(
    input: ManagedProcessRecordInput,
    options?: ManagedProcessRecordOptions,
  ): Promise<ManagedProcessRecord>;
  verify(record: ManagedProcessRecord): Promise<ManagedProcessVerification>;
  verifyProcessGroup(identity: ManagedProcessGroupIdentity): Promise<ManagedProcessVerification>;
  cleanupOwnedProcesses(ownershipToken: string): Promise<ManagedOwnedProcessCleanupResult>;
  remove(id: string): Promise<void>;
  list(): Promise<ManagedProcessRecord[]>;
  reapStale(): Promise<ManagedProcessReapResult>;
}

export interface ManagedOwnedProcessCleanupResult {
  complete: boolean;
  found: boolean;
}

export type ManagedProcessVerification = "match" | "mismatch" | "not-found" | "unknown";

export interface ManagedProcessSignalVerification {
  signal: NodeJS.Signals;
  verification: ManagedProcessVerification;
  processGroupAlive: boolean;
}

export function isManagedProcessSignalAllowed(options: ManagedProcessSignalVerification): boolean {
  return options.verification === "match";
}

interface ManagedProcessRegistryOptions {
  paseoHome: string;
  processTable: ManagedProcessTable;
  terminateProcess: ProcessTerminator;
  logger: Logger;
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
    ownershipToken: string | null,
  ): Promise<ManagedProcessVerification> {
    if (this.platform === "win32" || !Number.isInteger(processGroupId) || processGroupId <= 0) {
      return "not-found";
    }
    if (!ownershipToken) {
      return "unknown";
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let stdout: string;
      try {
        ({ stdout } = await this.commandRunner.exec("ps", ["-ax", "-o", "pid=", "-o", "pgid="]));
      } catch {
        return "unknown";
      }
      const memberPids = parseProcessGroupMemberPids(stdout, processGroupId);
      if (memberPids.length === 0) {
        return "not-found";
      }

      let inspectedMember = false;
      let missingToken = false;
      let inspectionFailed = false;
      for (const pid of memberPids) {
        const inspection = await this.inspect(pid);
        if (inspection.status === "error") {
          inspectionFailed = true;
          continue;
        }
        if (inspection.status === "not-found") {
          continue;
        }
        inspectedMember = true;
        if (inspection.snapshot.ownershipToken === ownershipToken) {
          return "match";
        }
        if (!inspection.snapshot.ownershipToken) {
          missingToken = true;
        }
      }

      if (inspectedMember) {
        return missingToken || inspectionFailed ? "unknown" : "mismatch";
      }
      if (attempt === 1 && inspectionFailed) {
        return "unknown";
      }
    }
    return "not-found";
  }

  async findOwnedProcessIds(ownershipToken: string): Promise<number[] | null> {
    if (this.platform === "win32") {
      return null;
    }
    try {
      const { stdout } = await this.commandRunner.exec("ps", [
        "eww",
        "-ax",
        "-o",
        "pid=",
        "-o",
        "command=",
      ]);
      return parseOwnedProcessIds(stdout, ownershipToken);
    } catch {
      return null;
    }
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
        ownershipToken: extractOwnershipToken(environmentOutput),
      },
    };
  }

  private async inspectWindows(pid: number): Promise<ManagedProcessInspection> {
    const command = [
      `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';`,
      "if ($process) { [pscustomobject]@{ ProcessId = $process.ProcessId; CommandLine = $process.CommandLine; CreationDate = $process.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }",
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
  private readonly recordOperations = new Map<string, Promise<void>>();
  private readonly activeRecordIds = new Set<string>();
  private readonly removedRecordIds = new Set<string>();

  constructor(options: ManagedProcessRegistryOptions) {
    this.directory = path.join(options.paseoHome, "runtime", "managed-processes");
    this.processTable = options.processTable;
    this.terminateProcess = options.terminateProcess;
    this.logger = options.logger.child({ module: "managed-processes" });
  }

  async record(
    input: ManagedProcessRecordInput,
    options?: ManagedProcessRecordOptions,
  ): Promise<ManagedProcessRecord> {
    const record: ManagedProcessRecord = {
      id: randomUUID(),
      owner: input.owner,
      pid: input.pid,
      command: input.command,
      args: input.args,
      metadata: input.metadata ?? {},
      identity: {
        commandLine: null,
        startedAt: null,
        ...(input.ownershipToken ? { ownershipToken: input.ownershipToken } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    this.activeRecordIds.add(record.id);
    try {
      await this.withRecordLock(record.id, () =>
        writeJsonFileAtomic(this.recordPath(record.id), record),
      );
      options?.onRecordPersisted?.(record);

      const inspection = await this.processTable.inspect(input.pid);
      const identifiedRecord = captureManagedProcessIdentity(record, inspection);
      options?.onIdentityCaptured?.(identifiedRecord);
      await this.withRecordLock(record.id, async () => {
        if (this.removedRecordIds.has(record.id)) {
          throw new Error("Managed process record was removed during identity capture");
        }
        await writeJsonFileAtomic(this.recordPath(record.id), identifiedRecord);
      });
      return identifiedRecord;
    } finally {
      this.activeRecordIds.delete(record.id);
      this.removedRecordIds.delete(record.id);
    }
  }

  async verify(record: ManagedProcessRecord): Promise<ManagedProcessVerification> {
    if (recordUsesProcessGroup(record)) {
      return this.processTable.inspectProcessGroup(
        record.pid,
        record.identity.ownershipToken ?? null,
      );
    }
    const inspection = await this.processTable.inspect(record.pid);
    if (inspection.status === "not-found") {
      return "not-found";
    }
    if (inspection.status === "error") {
      return "unknown";
    }
    return compareProcessIdentity(record, inspection.snapshot);
  }

  async verifyProcessGroup(
    identity: ManagedProcessGroupIdentity,
  ): Promise<ManagedProcessVerification> {
    return this.processTable.inspectProcessGroup(identity.processGroupId, identity.ownershipToken);
  }

  async cleanupOwnedProcesses(ownershipToken: string): Promise<ManagedOwnedProcessCleanupResult> {
    let found = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ownedProcessIds = await this.processTable.findOwnedProcessIds(ownershipToken);
      if (ownedProcessIds === null) {
        return { complete: false, found };
      }
      if (ownedProcessIds.length === 0) {
        return { complete: true, found };
      }
      found = true;
      const results = await Promise.all(
        ownedProcessIds.map((pid) =>
          this.terminateProcess(createPidTarget(pid), {
            gracefulTimeoutMs: MANAGED_PROCESS_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
            forceTimeoutMs: MANAGED_PROCESS_FORCE_SHUTDOWN_TIMEOUT_MS,
            signalProcessOnly: true,
            beforeSignal: async () =>
              (await this.verifyOwnedProcess(pid, ownershipToken)) === "match",
          }),
        ),
      );
      if (results.some((result) => result === "kill-timeout" || result === "signal-skipped")) {
        return { complete: false, found };
      }
    }
    const remaining = await this.processTable.findOwnedProcessIds(ownershipToken);
    return { complete: remaining?.length === 0, found };
  }

  private async verifyOwnedProcess(
    pid: number,
    ownershipToken: string,
  ): Promise<ManagedProcessVerification> {
    const inspection = await this.processTable.inspect(pid);
    if (inspection.status === "not-found") {
      return "not-found";
    }
    if (inspection.status === "error" || !inspection.snapshot.ownershipToken) {
      return "unknown";
    }
    return inspection.snapshot.ownershipToken === ownershipToken ? "match" : "mismatch";
  }

  async remove(id: string): Promise<void> {
    if (this.activeRecordIds.has(id)) {
      this.removedRecordIds.add(id);
    }
    await this.withRecordLock(id, () => fs.rm(this.recordPath(id), { force: true }));
  }

  async list(): Promise<ManagedProcessRecord[]> {
    const entries = await this.readEntries({ failOnUnreadable: true });
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
        const verification = await this.verify(entry.record);
        if (await this.reapOwnedProcessesWithoutGroup(entry.record, verification, result)) {
          continue;
        }
        if (verification === "not-found") {
          await this.remove(entry.record.id);
          result.dead += 1;
          result.removed += 1;
          continue;
        }

        if (verification === "unknown") {
          const message = "managed process identity is incomplete";
          result.errors.push({ id: entry.record.id, message });
          this.logger.warn(
            {
              id: entry.record.id,
              pid: entry.record.pid,
              owner: entry.record.owner,
            },
            "Could not inspect managed helper process; leaving record for next reconcile",
          );
          continue;
        }

        if (verification === "mismatch") {
          await this.remove(entry.record.id);
          result.mismatched += 1;
          result.removed += 1;
          continue;
        }

        const target = recordUsesProcessGroup(entry.record)
          ? createProcessGroupTarget(entry.record.pid)
          : createPidTarget(entry.record.pid);
        if (process.platform === "win32" && entry.record.metadata.directExecutable !== true) {
          result.errors.push({
            id: entry.record.id,
            message: "managed Windows process does not prove direct executable ownership",
          });
          continue;
        }
        const signalVerification: { current: ManagedProcessVerification } = {
          current: "unknown",
        };
        const termination = await this.terminateProcess(target, {
          gracefulTimeoutMs: MANAGED_PROCESS_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
          forceTimeoutMs: MANAGED_PROCESS_FORCE_SHUTDOWN_TIMEOUT_MS,
          signalProcessOnly: !recordUsesProcessGroup(entry.record),
          beforeSignal: async (signal) => {
            signalVerification.current = await this.verify(entry.record);
            return isManagedProcessSignalAllowed({
              signal,
              verification: signalVerification.current,
              processGroupAlive: recordUsesProcessGroup(entry.record),
            });
          },
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
        if (termination === "signal-skipped") {
          await this.finishSkippedSignal(entry.record, signalVerification.current, result);
          continue;
        }
        if (termination === "kill-timeout") {
          result.errors.push({
            id: entry.record.id,
            message: "managed process did not report exit after SIGKILL",
          });
          continue;
        }
        if (!(await this.finishOwnedProcessCleanup(entry.record, result))) {
          continue;
        }
        await this.remove(entry.record.id);
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

  private async reapOwnedProcessesWithoutGroup(
    record: ManagedProcessRecord,
    verification: ManagedProcessVerification,
    result: ManagedProcessReapResult,
  ): Promise<boolean> {
    const ownershipToken = recordOwnershipToken(record);
    if (!ownershipToken || (verification !== "not-found" && verification !== "mismatch")) {
      return false;
    }
    const cleanup = await this.cleanupOwnedProcesses(ownershipToken);
    if (!cleanup.complete) {
      this.addIncompleteOwnedCleanup(record, result);
      return true;
    }
    if (!cleanup.found) {
      return false;
    }
    await this.remove(record.id);
    result.removed += 1;
    result.terminated += 1;
    return true;
  }

  private async finishSkippedSignal(
    record: ManagedProcessRecord,
    verification: ManagedProcessVerification,
    result: ManagedProcessReapResult,
  ): Promise<void> {
    const ownershipToken = recordOwnershipToken(record);
    if (ownershipToken && (verification === "not-found" || verification === "mismatch")) {
      const cleanup = await this.cleanupOwnedProcesses(ownershipToken);
      if (!cleanup.complete) {
        this.addIncompleteOwnedCleanup(record, result);
        return;
      }
      await this.remove(record.id);
      result.removed += 1;
      result.terminated += cleanup.found ? 1 : 0;
      result.dead += cleanup.found ? 0 : 1;
      return;
    }
    if (verification === "mismatch") {
      await this.remove(record.id);
      result.mismatched += 1;
      result.removed += 1;
      return;
    }
    if (
      verification === "not-found" &&
      (!recordUsesProcessGroup(record) || !isProcessAlive(-record.pid))
    ) {
      await this.remove(record.id);
      result.dead += 1;
      result.removed += 1;
      return;
    }
    result.errors.push({
      id: record.id,
      message: "managed process identity could not be verified before a cleanup signal",
    });
  }

  private async finishOwnedProcessCleanup(
    record: ManagedProcessRecord,
    result: ManagedProcessReapResult,
  ): Promise<boolean> {
    const ownershipToken = recordOwnershipToken(record);
    if (!ownershipToken) {
      return true;
    }
    const cleanup = await this.cleanupOwnedProcesses(ownershipToken);
    if (cleanup.complete) {
      return true;
    }
    this.addIncompleteOwnedCleanup(record, result);
    return false;
  }

  private addIncompleteOwnedCleanup(
    record: ManagedProcessRecord,
    result: ManagedProcessReapResult,
  ): void {
    result.errors.push({
      id: record.id,
      message: "managed child process cleanup is incomplete",
    });
  }

  private recordPath(id: string): string {
    if (!MANAGED_PROCESS_ID_PATTERN.test(id)) {
      throw new Error(`Invalid managed process record id: ${id}`);
    }
    return path.join(this.directory, `${id}.json`);
  }

  private async readEntries(options?: {
    failOnUnreadable?: boolean;
  }): Promise<Array<{ path: string; record: ManagedProcessRecord }>> {
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
        if (options?.failOnUnreadable) {
          throw new Error(`Unreadable managed process record: ${fileName}`, { cause: error });
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
}

type ProcessIdentityComparison = "match" | "mismatch" | "unknown";

function captureManagedProcessIdentity(
  record: ManagedProcessRecord,
  inspection: ManagedProcessInspection,
): ManagedProcessRecord {
  if (inspection.status !== "alive") {
    const detail =
      inspection.status === "error" ? errorMessage(inspection.error) : "process not found";
    throw new Error(`Cannot record managed process identity: ${detail}`);
  }
  const snapshot = inspection.snapshot;
  if (!snapshot.commandLine || !snapshot.startedAt) {
    throw new Error("Cannot record managed process without command and start-time identity");
  }
  if (
    record.identity.ownershipToken &&
    snapshot.ownershipToken !== record.identity.ownershipToken
  ) {
    throw new Error("Cannot record managed process without its ownership token");
  }
  if (
    record.metadata.directExecutable === true &&
    compareProvisionalWindowsIdentity(record, snapshot) !== "match"
  ) {
    throw new Error("Cannot record managed process without its expected identity");
  }
  return {
    ...record,
    identity: {
      commandLine: snapshot.commandLine,
      startedAt: snapshot.startedAt,
      ...(record.identity.ownershipToken
        ? { ownershipToken: snapshot.ownershipToken ?? null }
        : {}),
    },
  };
}

function compareProcessIdentity(
  record: ManagedProcessRecord,
  snapshot: ManagedProcessSnapshot,
): ProcessIdentityComparison {
  if (
    record.metadata.directExecutable === true &&
    isIdentityValueMissing(record.identity.startedAt) &&
    isIdentityValueMissing(record.identity.commandLine)
  ) {
    return compareProvisionalWindowsIdentity(record, snapshot);
  }
  if (
    processStartIdentityDiffers(record.identity.startedAt, snapshot.startedAt) ||
    identityValueDiffers(record.identity.commandLine, snapshot.commandLine) ||
    identityValueDiffers(record.identity.ownershipToken, snapshot.ownershipToken)
  ) {
    return "mismatch";
  }

  if (
    isIdentityValueMissing(record.identity.startedAt) ||
    isIdentityValueMissing(snapshot.startedAt) ||
    isIdentityValueMissing(record.identity.commandLine) ||
    isIdentityValueMissing(snapshot.commandLine) ||
    (recordUsesProcessGroup(record) &&
      (isIdentityValueMissing(record.identity.ownershipToken) ||
        isIdentityValueMissing(snapshot.ownershipToken)))
  ) {
    return "unknown";
  }
  return "match";
}

function compareProvisionalWindowsIdentity(
  record: ManagedProcessRecord,
  snapshot: ManagedProcessSnapshot,
): ProcessIdentityComparison {
  if (!snapshot.commandLine || !snapshot.startedAt) {
    return "unknown";
  }
  const commandParts = parseWindowsCommandLine(snapshot.commandLine);
  if (
    commandParts.length !== record.args.length + 1 ||
    path.win32.normalize(commandParts[0] ?? "").toLowerCase() !==
      path.win32.normalize(record.command).toLowerCase() ||
    record.args.some((argument, index) => commandParts[index + 1] !== argument)
  ) {
    return "mismatch";
  }
  const processStartedAt = parseWindowsCreationDate(snapshot.startedAt);
  const recordCreatedAt = Date.parse(record.createdAt);
  if (processStartedAt === null || !Number.isFinite(recordCreatedAt)) {
    return "unknown";
  }
  if (
    processStartedAt > recordCreatedAt ||
    processStartedAt < recordCreatedAt - WINDOWS_PROVISIONAL_IDENTITY_WINDOW_MS
  ) {
    return "mismatch";
  }
  return "match";
}

function parseWindowsCommandLine(commandLine: string): string[] {
  const parts: string[] = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/\s/.test(commandLine[index] ?? "")) {
      index += 1;
    }
    if (index >= commandLine.length) {
      break;
    }

    let current = "";
    let quoted = false;
    while (index < commandLine.length) {
      let backslashes = 0;
      while (commandLine[index] === "\\") {
        backslashes += 1;
        index += 1;
      }
      if (commandLine[index] === '"') {
        current += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          current += '"';
        } else {
          quoted = !quoted;
        }
        index += 1;
        continue;
      }
      current += "\\".repeat(backslashes);
      const character = commandLine[index];
      if (character === undefined || (/\s/.test(character) && !quoted)) {
        break;
      }
      current += character;
      index += 1;
    }
    if (quoted) {
      return [];
    }
    parts.push(current);
  }
  return parts;
}

function parseWindowsCreationDate(value: string): number | null {
  const isoTimestamp = Date.parse(value);
  if (Number.isFinite(isoTimestamp)) {
    return isoTimestamp;
  }
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/);
  if (!match) {
    return null;
  }
  const localTime = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7].slice(0, 3)),
  );
  const offsetMinutes = Number(match[9]) * (match[8] === "+" ? 1 : -1);
  return localTime - offsetMinutes * 60_000;
}

function identityValueDiffers(
  recorded: string | null | undefined,
  observed: string | null | undefined,
): boolean {
  return typeof recorded === "string" && typeof observed === "string" && recorded !== observed;
}

function processStartIdentityDiffers(
  recorded: string | null | undefined,
  observed: string | null | undefined,
): boolean {
  if (typeof recorded !== "string" || typeof observed !== "string") {
    return false;
  }
  const recordedTimestamp = parseWindowsCreationDate(recorded);
  const observedTimestamp = parseWindowsCreationDate(observed);
  if (recordedTimestamp !== null && observedTimestamp !== null) {
    return recordedTimestamp !== observedTimestamp;
  }
  return recorded !== observed;
}

function isIdentityValueMissing(value: string | null | undefined): boolean {
  return typeof value !== "string";
}

export function createPidTarget(pid: number): TreeKillTarget {
  return createPollingTarget(pid);
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

function recordUsesProcessGroup(record: ManagedProcessRecord): boolean {
  return record.metadata.terminationScope === "process-group";
}

function recordOwnershipToken(record: ManagedProcessRecord): string | null {
  if (!recordUsesProcessGroup(record)) {
    return null;
  }
  return record.identity.ownershipToken ?? null;
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

function extractOwnershipToken(commandWithEnvironment: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)${MANAGED_PROCESS_OWNERSHIP_TOKEN_ENV}=([^\\s]+)`);
  return commandWithEnvironment.match(pattern)?.[1] ?? null;
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

function parseOwnedProcessIds(output: string, ownershipToken: string): number[] {
  const processIds: number[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match && extractOwnershipToken(match[2] ?? "") === ownershipToken) {
      processIds.push(Number(match[1]));
    }
  }
  return processIds;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
