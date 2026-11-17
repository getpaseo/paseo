import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { findExecutableWithoutProbing } from "../../../executable-resolution/executable-resolution.js";

const execFileAsync = promisify(execFile);

const HOST_COMMAND_TIMEOUT_MS = 10_000;

/** A host command that could not be run or exited non-zero, with what it printed. */
export class ResourceHostCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly stderr: string,
  ) {
    super(`${basename(command)} failed: ${stderr.trim() || "no output"}`);
    this.name = "ResourceHostCommandError";
  }
}

export interface HostCommand {
  command: string;
  args: string[];
  /** Added to the daemon's environment for this command. */
  env?: Record<string, string>;
}

/**
 * Everything agent resources ask of the operating system. The default talks to the
 * real host; tests substitute one to stand in for hosts they cannot be run on.
 */
export interface ResourceHost {
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  readonly env: NodeJS.ProcessEnv;
  /** Absolute path of a command on PATH, without running it. */
  findExecutable(name: string): Promise<string | null>;
  /** Resolves with stdout. Rejects with `ResourceHostCommandError`. */
  exec(command: HostCommand): Promise<string>;
  readFile(path: string): Promise<string>;
  listDirectories(path: string): Promise<string[]>;
  /** `setpriority(2)` on one thread. Throws on failure; read the errno with `errnoOf`. */
  setPriority(tid: number, nice: number): void;
  getPriority(tid: number): number;
  sleep(ms: number): Promise<void>;
}

export function createResourceHost(): ResourceHost {
  return {
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    env: process.env,
    findExecutable: (name) => findExecutableWithoutProbing(name, { cwd: process.cwd() }),
    async exec({ command, args, env }) {
      try {
        const { stdout } = await execFileAsync(command, args, {
          encoding: "utf8",
          timeout: HOST_COMMAND_TIMEOUT_MS,
          ...(env ? { env: { ...process.env, ...env } } : {}),
        });
        return stdout;
      } catch (error) {
        const stderr =
          error instanceof Error && "stderr" in error && typeof error.stderr === "string"
            ? error.stderr
            : "";
        throw new ResourceHostCommandError(
          command,
          stderr || (error instanceof Error ? error.message : String(error)),
        );
      }
    },
    readFile: (path) => readFile(path, "utf8"),
    async listDirectories(path) {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    },
    setPriority: (tid, nice) => os.setPriority(tid, nice),
    getPriority: (tid) => os.getPriority(tid),
    sleep: (ms) => sleep(ms),
  };
}

/**
 * The errno behind a failed system call. Node's `os` functions throw
 * `ERR_SYSTEM_ERROR` and keep the errno under `info.code`; `fs` and child-process
 * errors carry it as `code`.
 */
export function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const info = "info" in error ? error.info : undefined;
  if (
    typeof info === "object" &&
    info !== null &&
    "code" in info &&
    typeof info.code === "string"
  ) {
    return info.code;
  }
  return "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export function isPermissionFailure(error: unknown): boolean {
  if (error instanceof ResourceHostCommandError) {
    return /access denied|permission denied|not permitted|authentication required/i.test(
      error.stderr,
    );
  }
  const code = errnoOf(error);
  return code === "EACCES" || code === "EPERM";
}

/**
 * What reading a /proc or cgroup entry fails with when the process or cgroup is gone,
 * the cgroup has no such controller, or the entry belongs to another user.
 */
const UNREADABLE_ENTRY_ERRNOS = new Set([
  "ENOENT",
  "ESRCH",
  "ENODEV",
  "ENOTDIR",
  "EACCES",
  "EPERM",
]);

function isUnreadableEntry(error: unknown): boolean {
  const code = errnoOf(error);
  return code !== undefined && UNREADABLE_ENTRY_ERRNOS.has(code);
}

async function readOptional(host: ResourceHost, path: string): Promise<string | null> {
  try {
    return await host.readFile(path);
  } catch (error) {
    if (isUnreadableEntry(error)) {
      return null;
    }
    throw error;
  }
}

async function listOptional(host: ResourceHost, path: string): Promise<string[]> {
  try {
    return await host.listDirectories(path);
  } catch (error) {
    if (isUnreadableEntry(error)) {
      return [];
    }
    throw error;
  }
}

function parseIds(text: string | null): number[] {
  if (!text) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => Number.parseInt(line, 10))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/** Every thread in a cgroup and the cgroups below it. */
export async function listCgroupThreads(host: ResourceHost, cgroupDir: string): Promise<number[]> {
  const threads = parseIds(await readOptional(host, `${cgroupDir}/cgroup.threads`));
  for (const child of await listOptional(host, cgroupDir)) {
    threads.push(...(await listCgroupThreads(host, `${cgroupDir}/${child}`)));
  }
  return threads;
}

/** Every thread of the given processes and their descendants, read from /proc. */
export async function listProcessTreeThreads(
  host: ResourceHost,
  rootPids: Iterable<number>,
): Promise<number[]> {
  const childrenByParent = new Map<number, number[]>();
  for (const entry of await listOptional(host, "/proc")) {
    const pid = Number.parseInt(entry, 10);
    if (!Number.isInteger(pid) || String(pid) !== entry) {
      continue;
    }
    const stat = await readOptional(host, `/proc/${pid}/stat`);
    // The command name sits in parentheses and may itself contain them and spaces.
    const afterName = stat?.slice(stat.lastIndexOf(")") + 2).split(" ");
    const parent = Number.parseInt(afterName?.[1] ?? "", 10);
    if (Number.isInteger(parent)) {
      childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), pid]);
    }
  }
  const threads: number[] = [];
  const pending = [...rootPids];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    threads.push(...(await listOptional(host, `/proc/${pid}/task`)).map(Number));
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return threads;
}

const BYTES_PER_MB = 1024 * 1024;

/** What the kernel currently enforces on a cgroup; `null` means no limit is set. */
export interface CgroupLimits {
  cpuWeight: number | null;
  cpuQuotaPercent: number | null;
  memoryHighMb: number | null;
  memoryMaxMb: number | null;
  allowedCpus: number[] | null;
}

function parseMemoryLimit(text: string | null): number | null {
  const value = text?.trim();
  if (!value || value === "max") {
    return null;
  }
  return Number.parseInt(value, 10) / BYTES_PER_MB;
}

/** A kernel CPU list such as `0-3,8`, or null when the file is empty or missing. */
export function parseCpuList(text: string | null): number[] | null {
  const value = text?.trim();
  if (!value) {
    return null;
  }
  const cpus: number[] = [];
  for (const range of value.split(",")) {
    const [first, last = first] = range.split("-").map((bound) => Number.parseInt(bound, 10));
    for (let cpu = first; cpu <= last; cpu += 1) {
      cpus.push(cpu);
    }
  }
  return cpus;
}

/** Controllers enabled for a cgroup, or null when it is not on a cgroup v2 hierarchy. */
export async function readCgroupControllers(
  host: ResourceHost,
  cgroupDir: string,
): Promise<Set<string> | null> {
  const controllers = await readOptional(host, `${cgroupDir}/cgroup.controllers`);
  return controllers === null ? null : new Set(controllers.trim().split(/\s+/).filter(Boolean));
}

/** The CPUs a cgroup's processes can run on, which may be fewer than it asked for. */
export async function readEffectiveCpus(
  host: ResourceHost,
  cgroupDir: string,
): Promise<number[] | null> {
  return parseCpuList(await readOptional(host, `${cgroupDir}/cpuset.cpus.effective`));
}

/** A controller that is not enabled for the cgroup has no file, which reads as no limit. */
export async function readCgroupLimits(
  host: ResourceHost,
  cgroupDir: string,
): Promise<CgroupLimits> {
  const cpuMax = (await readOptional(host, `${cgroupDir}/cpu.max`))?.trim().split(" ");
  const cpuWeight = (await readOptional(host, `${cgroupDir}/cpu.weight`))?.trim();
  return {
    cpuWeight: cpuWeight ? Number.parseInt(cpuWeight, 10) : null,
    cpuQuotaPercent:
      cpuMax && cpuMax[0] !== "max"
        ? Math.round((Number.parseInt(cpuMax[0], 10) / Number.parseInt(cpuMax[1], 10)) * 100)
        : null,
    memoryHighMb: parseMemoryLimit(await readOptional(host, `${cgroupDir}/memory.high`)),
    memoryMaxMb: parseMemoryLimit(await readOptional(host, `${cgroupDir}/memory.max`)),
    // The effective set, not the requested one: when none of the requested CPUs is
    // available, the kernel falls back to the parent's CPUs without an error.
    allowedCpus: await readEffectiveCpus(host, cgroupDir),
  };
}
