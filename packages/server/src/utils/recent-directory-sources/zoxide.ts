import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPathInsideRoot } from "../path.js";
import type { RecentDirectorySource, RecentDirectorySourceLogger } from "./index.js";

export interface ZoxideRecentSourceConfig {
  enabled?: boolean;
  path?: string;
  dataDir?: string;
}

interface ZoxideRecentSourceDeps {
  env?: NodeJS.ProcessEnv;
  logger?: RecentDirectorySourceLogger;
}

interface QueryResult {
  stdout: string;
}

const PROBE_TIMEOUT_MS = 1_000;
const QUERY_TIMEOUT_MS = 300;
const CACHE_TTL_MS = 5_000;
const CACHE_MAX_ENTRIES = 64;
const MAX_OUTPUT_BYTES = 1024 * 1024;

// daemon processes launched by the packaged app do not inherit the login shell's PATH, so a
// bare `zoxide` lookup is not enough. These are the install locations a PATH-less launch misses.
function commonZoxideBinaries(homeDir: string): string[] {
  return [
    path.join("/opt/homebrew/bin", "zoxide"),
    path.join("/usr/local/bin", "zoxide"),
    path.join(homeDir, ".cargo", "bin", "zoxide"),
    path.join(homeDir, ".local", "bin", "zoxide"),
    "/usr/bin/zoxide",
  ];
}

function isExecutableFile(filePath: string): boolean {
  try {
    const info = statSync(filePath);
    if (!info.isFile()) return false;
    if (process.platform !== "win32") accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveZoxideBinary(
  configured: string | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  if (configured) return expandZoxidePath(configured, env);
  const homeDir = env.HOME ?? os.homedir();
  for (const candidate of commonZoxideBinaries(homeDir)) {
    if (isExecutableFile(candidate)) return candidate;
  }
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "zoxide");
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function resolveZoxideDataDir(
  configured: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (configured) return expandZoxidePath(configured, env);
  const fromEnv = env._ZO_DATA_DIR;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

function expandZoxidePath(value: string, env: NodeJS.ProcessEnv): string {
  const homeDir = env.HOME ?? os.homedir();
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
}

function execFileAsync(
  command: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeout,
        env: options.env,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

// zoxide keeps a frecency-ranked list of directories the user actually `cd`-ed into. Reading it
// sidesteps the scan budget that makes deep directories unreachable in a plain tree walk.
export class ZoxideRecentDirectorySource implements RecentDirectorySource {
  readonly id = "zoxide";

  private readonly disabled: boolean;
  private readonly configuredBinary: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: RecentDirectorySourceLogger | undefined;
  private resolvedBinary: string | null = null;
  private available: boolean | null = null;
  private probePromise: Promise<boolean> | null = null;
  private readonly cache = new Map<string, { expiresAt: number; paths: string[] }>();

  constructor(config: ZoxideRecentSourceConfig = {}, deps: ZoxideRecentSourceDeps = {}) {
    this.disabled = config.enabled === false;
    this.configuredBinary = config.path;
    this.env = { ...(deps.env ?? process.env) };
    this.logger = deps.logger;
    const dataDir = resolveZoxideDataDir(config.dataDir, this.env);
    if (dataDir) this.env._ZO_DATA_DIR = dataDir;
  }

  isAvailable(): boolean {
    return this.available === true;
  }

  async query(input: { query: string; root: string; limit: number }): Promise<string[]> {
    if (this.disabled) return [];
    const keyword = input.query.trim();
    // Phase 1: frecency display for an empty query needs a client-side bare-query change, so the
    // recent source stays out of that path entirely.
    if (!keyword || input.limit <= 0) return [];
    const binary = await this.ensureAvailable();
    if (!binary) return [];

    const cacheKey = `${input.root}\u0000${input.limit}\u0000${keyword}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.paths;

    const paths = await this.runQuery(binary, keyword, input.root, input.limit);
    this.cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, paths });
    pruneCache(this.cache);
    if (paths.length > 0) {
      this.logger?.info(
        { source: this.id, query: keyword, root: input.root, count: paths.length, paths },
        "zoxide recent directories matched",
      );
    } else {
      this.logger?.debug(
        { source: this.id, query: keyword, root: input.root },
        "zoxide recent directories matched nothing",
      );
    }
    return paths;
  }

  private async ensureAvailable(): Promise<string | null> {
    if (this.available === null) {
      this.probePromise ??= this.probe();
      this.available = await this.probePromise;
    }
    return this.available ? this.resolvedBinary : null;
  }

  private async probe(): Promise<boolean> {
    const binary = resolveZoxideBinary(this.configuredBinary, this.env);
    if (!binary) {
      this.logger?.debug({ source: this.id }, "zoxide binary not found; recent source disabled");
      return false;
    }
    try {
      await execFileAsync(binary, ["--version"], { timeout: PROBE_TIMEOUT_MS, env: this.env });
      this.resolvedBinary = binary;
      this.logger?.info(
        { source: this.id, binary, dataDir: this.env._ZO_DATA_DIR ?? null },
        "zoxide recent directory source ready",
      );
      return true;
    } catch {
      this.logger?.debug(
        { source: this.id, binary },
        "zoxide probe failed; recent source disabled",
      );
      return false;
    }
  }

  private async runQuery(
    binary: string,
    keyword: string,
    root: string,
    limit: number,
  ): Promise<string[]> {
    const resolvedRoot = await realpath(root).catch(() => path.resolve(root));
    let stdout: string;
    try {
      // `keyword` is a single argv element, never shell-interpolated: it comes from a client.
      const result = await execFileAsync(
        binary,
        ["query", "-l", "--base-dir", resolvedRoot, keyword],
        { timeout: QUERY_TIMEOUT_MS, env: this.env },
      );
      stdout = result.stdout;
    } catch {
      return [];
    }

    const paths: string[] = [];
    const seen = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (paths.length >= limit) break;
      const candidate = line.trim();
      if (!candidate || !path.isAbsolute(candidate)) continue;
      // Canonicalize so paths line up with the scan, which walks the realpath'd root, and so a
      // symlinked home (e.g. macOS `/var` -> `/private/var`) still passes containment.
      const absolute = await realpath(candidate).catch(() => null);
      if (!absolute || seen.has(absolute) || !isPathInsideRoot(resolvedRoot, absolute)) continue;
      seen.add(absolute);
      const info = await stat(absolute).catch(() => null);
      if (!info?.isDirectory()) continue;
      paths.push(absolute);
    }
    return paths;
  }
}

function pruneCache(cache: Map<string, { expiresAt: number; paths: string[] }>): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const key = cache.keys().next().value;
    if (!key) return;
    cache.delete(key);
  }
}
