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
const MANAGED_PROCESS_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

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
}

export interface ManagedProcessTable {
  inspect(pid: number): Promise<ManagedProcessSnapshot | null>;
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
  list(): Promise<ManagedProcessRecord[]>;
  reapStale(): Promise<ManagedProcessReapResult>;
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

export function createSystemManagedProcessTable(_options?: {
  platform?: NodeJS.Platform;
  commandRunner?: ManagedProcessCommandRunner;
}): ManagedProcessTable {
  return new SystemManagedProcessTable({
    platform: _options?.platform ?? process.platform,
    commandRunner: _options?.commandRunner ?? {
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

  async inspect(pid: number): Promise<ManagedProcessSnapshot | null> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }

    try {
      return this.platform === "win32"
        ? await this.inspectWindows(pid)
        : await this.inspectPosix(pid);
    } catch {
      return null;
    }
  }

  private async inspectPosix(pid: number): Promise<ManagedProcessSnapshot | null> {
    const { stdout } = await this.commandRunner.exec("ps", [
      "-ww",
      "-p",
      String(pid),
      "-o",
      "lstart=",
      "-o",
      "command=",
    ]);
    const line = stdout.trimEnd();
    if (!line) {
      return null;
    }

    const startedAt = line.slice(0, 24).trim();
    const commandLine = line.slice(24).trim();
    return {
      pid,
      commandLine: commandLine || null,
      startedAt: startedAt || null,
    };
  }

  private async inspectWindows(pid: number): Promise<ManagedProcessSnapshot | null> {
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
      return null;
    }

    const parsed = WindowsProcessSnapshotSchema.parse(JSON.parse(trimmed));
    return {
      pid,
      commandLine: parsed.CommandLine ?? null,
      startedAt: parsed.CreationDate ?? null,
    };
  }
}

class FileBackedManagedProcessRegistry implements ManagedProcessRegistry {
  private readonly directory: string;
  private readonly processTable: ManagedProcessTable;
  private readonly terminateProcess: ProcessTerminator;
  private readonly logger: Logger;

  constructor(options: ManagedProcessRegistryOptions) {
    this.directory = path.join(options.paseoHome, "runtime", "managed-processes");
    this.processTable = options.processTable;
    this.terminateProcess = options.terminateProcess;
    this.logger = options.logger.child({ module: "managed-processes" });
  }

  async record(input: ManagedProcessRecordInput): Promise<ManagedProcessRecord> {
    const snapshot = await this.processTable.inspect(input.pid);
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
      },
      createdAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(this.recordPath(record.id), record);
    return record;
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.recordPath(id), { force: true });
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
        const snapshot = await this.processTable.inspect(entry.record.pid);
        if (!snapshot) {
          await fs.rm(entry.path, { force: true });
          result.dead += 1;
          result.removed += 1;
          continue;
        }

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
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = ManagedProcessRecordSchema.parse(JSON.parse(raw));
      entries.push({ path: filePath, record: parsed });
    }
    return entries;
  }
}

function processIdentityMatches(
  record: ManagedProcessRecord,
  snapshot: ManagedProcessSnapshot,
): boolean {
  if (record.identity.startedAt && snapshot.startedAt) {
    if (record.identity.startedAt !== snapshot.startedAt) {
      return false;
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
  const normalized = normalizeCommandLine(commandLine);
  const commandName = path.basename(record.command).toLowerCase();
  return [commandName, ...record.args].every((token) => normalized.includes(token.toLowerCase()));
}

function normalizeCommandLine(commandLine: string): string {
  return commandLine.replace(/\s+/g, " ").trim().toLowerCase();
}

function createPidTarget(pid: number): TreeKillTarget {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill(signal?: NodeJS.Signals | number) {
      process.kill(pid, signal);
      return true;
    },
  };
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
