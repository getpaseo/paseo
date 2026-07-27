import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { ProcessLaunchStrategy } from "./launch-strategy.js";

/**
 * The filesystem an agent's own files live on.
 *
 * Providers keep their session transcripts outside the workspace — Claude in
 * `~/.claude/projects`, omp in its session directory — and Paseo reads them to
 * list importable sessions and to rebuild a resumed conversation. For a
 * container workspace those files are the *container's*: the agent wrote them
 * inside it, under the container's HOME, keyed by the container's cwd. Reading
 * the host's copies there answers with another machine's sessions, or with
 * nothing at all.
 *
 * So the reads go where the agent runs. The host implementation is plain
 * `node:fs`; the container implementation runs the equivalent POSIX commands
 * through the workspace's launch strategy. Both are local disks — what the
 * container costs is a process spawn per operation, which is why the listing
 * is one `find` rather than a walk plus a stat each.
 *
 * Writes go the same way, for the mirror-image reason: a provider configured
 * through files (Pi takes `--mcp-config` and `--extension` as paths) needs
 * them where the agent will look, and the daemon's `/tmp` is not the
 * container's. Reads answer null for anything missing; writes throw, because a
 * config file that never landed shows up later as an agent that silently lost
 * half its capabilities.
 */

export interface LaunchFileStat {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface ListFilesOptions {
  /** Only files ending in this, e.g. ".jsonl". */
  suffix: string;
  /** How far below the root to descend; 1 means the root itself only. */
  maxDepth: number;
}

export interface WriteFileOptions {
  /** Permission bits, for files carrying credentials. Defaults to the umask. */
  mode?: number;
}

export interface LaunchFileSystem {
  /**
   * Whether these paths belong to a container rather than the host. Still a
   * local disk either way — the difference is that reaching it costs a process
   * spawn (~75ms) instead of a file read (~1ms).
   */
  readonly isIsolated: boolean;
  /** HOME as the environment defines it — the container's user, not ours. */
  homeDir(): Promise<string>;
  exists(filePath: string): Promise<boolean>;
  readFile(filePath: string): Promise<string | null>;
  /** First `bytes` of a file; transcripts put their header at the top. */
  readHead(filePath: string, bytes: number): Promise<string | null>;
  /** Last `bytes` of a file; transcripts put the latest activity at the end. */
  readTail(filePath: string, bytes: number): Promise<string | null>;
  listFiles(root: string, options: ListFilesOptions): Promise<LaunchFileStat[]>;
  /** A private directory for files the agent must be able to open. Throws. */
  makeTempDir(prefix: string): Promise<string>;
  /** Writes `contents`, creating parent directories. Throws on failure. */
  writeFile(filePath: string, contents: string, options?: WriteFileOptions): Promise<void>;
  /** Removes a file or a whole directory; a missing path is not an error. */
  remove(filePath: string): Promise<void>;
}

/** Bounded so one probe can't hang an import listing indefinitely. */
const CONTAINER_COMMAND_TIMEOUT_MS = 15_000;

export function createLaunchFileSystem(strategy?: ProcessLaunchStrategy | null): LaunchFileSystem {
  return strategy?.isIsolated ? new ContainerLaunchFileSystem(strategy) : HOST_FILE_SYSTEM;
}

class HostLaunchFileSystem implements LaunchFileSystem {
  readonly isIsolated = false;

  async homeDir(): Promise<string> {
    return homedir();
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  async readHead(filePath: string, bytes: number): Promise<string | null> {
    return this.readSlice(filePath, bytes, "head");
  }

  async readTail(filePath: string, bytes: number): Promise<string | null> {
    return this.readSlice(filePath, bytes, "tail");
  }

  private async readSlice(
    filePath: string,
    bytes: number,
    end: "head" | "tail",
  ): Promise<string | null> {
    const handle = await open(filePath, "r").catch(() => null);
    if (!handle) return null;
    try {
      const size = (await handle.stat()).size;
      const length = end === "head" ? Math.min(bytes, size) : Math.min(bytes, size);
      const start = end === "head" ? 0 : Math.max(0, size - bytes);
      if (length <= 0) return null;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      if (bytesRead <= 0) return null;
      return buffer.subarray(0, bytesRead).toString("utf8");
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async listFiles(root: string, options: ListFilesOptions): Promise<LaunchFileStat[]> {
    const found: LaunchFileStat[] = [];
    await this.walk(root, options, 1, found);
    return found;
  }

  private async walk(
    dir: string,
    options: ListFilesOptions,
    depth: number,
    found: LaunchFileStat[],
  ): Promise<void> {
    if (depth > options.maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(entryPath, options, depth + 1, found);
        continue;
      }
      if (!entry.name.endsWith(options.suffix)) continue;
      try {
        const stats = await stat(entryPath);
        found.push({ path: entryPath, mtimeMs: stats.mtimeMs, size: stats.size });
      } catch {
        // Vanished between listing and stat — skip it.
      }
    }
  }

  async makeTempDir(prefix: string): Promise<string> {
    return mkdtemp(path.join(tmpdir(), prefix));
  }

  async writeFile(filePath: string, contents: string, options?: WriteFileOptions): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, {
      encoding: "utf8",
      ...(options?.mode === undefined ? {} : { mode: options.mode }),
    });
  }

  async remove(filePath: string): Promise<void> {
    await rm(filePath, { force: true, recursive: true }).catch(() => undefined);
  }
}

const HOST_FILE_SYSTEM = new HostLaunchFileSystem();

/**
 * The same operations as POSIX commands run inside the environment. Every
 * container image has these; nothing here assumes GNU coreutils over busybox.
 */
class ContainerLaunchFileSystem implements LaunchFileSystem {
  readonly isIsolated = true;

  private readonly strategy: ProcessLaunchStrategy;
  private home: Promise<string> | null = null;

  constructor(strategy: ProcessLaunchStrategy) {
    this.strategy = strategy;
  }

  async homeDir(): Promise<string> {
    this.home ??= this.run(`printf %s "$HOME"`).then((output) => output?.trim() || "/root");
    return this.home;
  }

  async exists(filePath: string): Promise<boolean> {
    return (await this.run(`test -e ${quote(filePath)} && printf yes`)) === "yes";
  }

  async readFile(filePath: string): Promise<string | null> {
    return this.run(`cat ${quote(filePath)}`);
  }

  async readHead(filePath: string, bytes: number): Promise<string | null> {
    return this.run(`head -c ${Math.floor(bytes)} ${quote(filePath)}`);
  }

  async readTail(filePath: string, bytes: number): Promise<string | null> {
    return this.run(`tail -c ${Math.floor(bytes)} ${quote(filePath)}`);
  }

  async listFiles(root: string, options: ListFilesOptions): Promise<LaunchFileStat[]> {
    // One command for the whole walk: a per-file stat would be one exec each.
    const output = await this.run(
      `find ${quote(root)} -maxdepth ${Math.floor(options.maxDepth)} -type f -name ${quote(
        `*${options.suffix}`,
      )} -exec stat -c '%Y %s %n' {} + 2>/dev/null`,
    );
    if (!output) return [];
    const files: LaunchFileStat[] = [];
    for (const line of output.split("\n")) {
      const parsed = parseStatLine(line);
      if (parsed) files.push(parsed);
    }
    return files;
  }

  async makeTempDir(prefix: string): Promise<string> {
    // TMPDIR rather than a hardcoded /tmp: some images point it elsewhere, and
    // the six X's are what every mktemp — busybox included — expects.
    const template = `${sanitizeTempPrefix(prefix)}XXXXXX`;
    const created = (await this.run(`mktemp -d "\${TMPDIR:-/tmp}/${template}"`))?.trim();
    if (!created) {
      throw new Error("Could not create a temporary directory inside the container");
    }
    return created;
  }

  async writeFile(filePath: string, contents: string, options?: WriteFileOptions): Promise<void> {
    // Container paths are POSIX whatever the daemon runs on.
    const dir = path.posix.dirname(filePath);
    // chmod in the same command, so a file holding credentials is never
    // briefly world-readable between two execs.
    const chmod =
      options?.mode === undefined
        ? ""
        : ` && chmod ${options.mode.toString(8).padStart(3, "0")} ${quote(filePath)}`;
    const written = await this.runWithStdin(
      `mkdir -p ${quote(dir)} && cat > ${quote(filePath)}${chmod}`,
      contents,
    );
    if (!written) {
      throw new Error(`Could not write ${filePath} inside the container`);
    }
  }

  async remove(filePath: string): Promise<void> {
    await this.run(`rm -rf ${quote(filePath)}`);
  }

  private async run(script: string): Promise<string | null> {
    try {
      const child = this.strategy.spawn("sh", ["-c", script], {
        stdio: ["ignore", "pipe", "ignore"],
        signal: AbortSignal.timeout(CONTAINER_COMMAND_TIMEOUT_MS),
      });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      const [code] = (await once(child, "close")) as [number | null];
      return code === 0 ? stdout : null;
    } catch {
      return null;
    }
  }

  private async runWithStdin(script: string, input: string): Promise<boolean> {
    try {
      const child = this.strategy.spawn("sh", ["-c", script], {
        stdio: ["pipe", "ignore", "ignore"],
        signal: AbortSignal.timeout(CONTAINER_COMMAND_TIMEOUT_MS),
      });
      child.stdin?.end(input);
      const [code] = (await once(child, "close")) as [number | null];
      return code === 0;
    } catch {
      return false;
    }
  }
}

/**
 * The prefix names a directory the daemon chose, so it never legitimately
 * contains shell metacharacters — drop anything that does rather than quote
 * around it, since the template has to sit inside the expansion of TMPDIR.
 */
function sanitizeTempPrefix(prefix: string): string {
  const cleaned = prefix.replace(/[^A-Za-z0-9._-]/gu, "");
  return cleaned || "paseo-";
}

/**
 * `stat -c '%Y %s %n'` — seconds, bytes, then the path, which may itself
 * contain spaces. Only a newline in a filename would defeat this, and no agent
 * writes one.
 */
function parseStatLine(line: string): LaunchFileStat | null {
  const match = /^(\d+)\s+(\d+)\s+(.+)$/u.exec(line.trim());
  if (!match) return null;
  const [, seconds, size, filePath] = match;
  return {
    path: filePath,
    mtimeMs: Number(seconds) * 1000,
    size: Number(size),
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
