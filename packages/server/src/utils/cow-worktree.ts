import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const COW_SEED_MARKER = "cow-seed";
const COW_SEED_MODULES_LOCK_MARKER = "cow-seed-modules-lock";

export const DEFAULT_SHARED_HIDDEN_DIRS = new Set([
  ".svelte-kit",
  ".turbo",
  ".next",
  ".nuxt",
  ".parcel-cache",
]);

const HARD_DENY_NAMES = new Set([
  ".git",
  ".git-cow",
  ".cow-seed",
  ".paseo",
  ".claude",
  ".codex",
  ".aws",
  ".cursor",
  "docker-compose.override.yml",
  "docker-compose.override.yaml",
]);

const INSTALL_LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
];

export interface CowExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
}

export type CowExec = (
  program: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<CowExecResult> | CowExecResult;

export interface ReflinkProbeResult {
  supported: boolean;
  mechanism: "clone" | "reflink" | null;
  reason: string | null;
}

export interface CowWorktreeMaterializeResult {
  mechanism: "clone" | "reflink" | "plain";
  fallbackReason: string | null;
  seedDir: string | null;
  clonedEntries: string[];
  lockfileMatched: boolean;
}

function defaultExec(
  program: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<CowExecResult> {
  return new Promise((resolveResult) => {
    execFile(
      program,
      args,
      {
        encoding: "utf8",
        cwd: options?.cwd,
        timeout: options?.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolveResult({ status: 0, stdout: stdout ?? "", stderr: stderr ?? "", error: null });
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : 1;
        resolveResult({
          status: exitCode,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          error: typeof error.code === "number" ? null : error,
        });
      },
    );
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runGit(cwd: string, args: string[], exec: CowExec): Promise<string> {
  const res = await exec("git", [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-C",
    cwd,
    ...args,
  ]);
  if (res.error || res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || res.stdout).trim()}`);
  }
  return res.stdout.trim();
}

export function cloneEntryCommand(
  platform: NodeJS.Platform = process.platform,
): { program: string; args: string[] } | null {
  if (platform === "darwin") return { program: "/bin/cp", args: ["-c", "-R", "-p"] };
  if (platform === "linux") return { program: "cp", args: ["-a", "--reflink=always"] };
  return null;
}

export function isExcludedCowEntry(
  name: string,
  trackedTopLevel: Set<string>,
  sharedHiddenDirs: Set<string> = DEFAULT_SHARED_HIDDEN_DIRS,
): boolean {
  if (!name || name === "." || name === "..") return true;
  if (HARD_DENY_NAMES.has(name)) return true;
  if (name.toLowerCase().includes(".env")) return true;
  if (/^docker-compose\.override\.ya?ml$/i.test(name)) return true;
  if (name.startsWith(".")) {
    return !sharedHiddenDirs.has(name) && !trackedTopLevel.has(name);
  }
  return false;
}

export async function supportsReflink(
  directory: string,
  options?: { platform?: NodeJS.Platform; exec?: CowExec },
): Promise<ReflinkProbeResult> {
  const platform = options?.platform ?? process.platform;
  const spec = cloneEntryCommand(platform);
  if (!spec) return { supported: false, mechanism: null, reason: "unsupported-platform" };
  await mkdir(directory, { recursive: true });
  const token = randomUUID();
  const src = join(directory, `.paseo-cow-probe-src-${token}`);
  const dst = join(directory, `.paseo-cow-probe-dst-${token}`);
  try {
    await writeFile(src, "cow-probe\n", { mode: 0o600 });
    const res = await (options?.exec ?? defaultExec)(spec.program, [...spec.args, src, dst], {
      timeoutMs: 10_000,
    });
    if (!res.error && res.status === 0 && (await pathExists(dst))) {
      return {
        supported: true,
        mechanism: platform === "darwin" ? "clone" : "reflink",
        reason: null,
      };
    }
    return { supported: false, mechanism: null, reason: "reflink-unsupported" };
  } catch {
    return { supported: false, mechanism: null, reason: "probe-failed" };
  } finally {
    await rm(src, { force: true }).catch(() => undefined);
    await rm(dst, { force: true }).catch(() => undefined);
  }
}

async function fileSha256(filePath: string): Promise<string | null> {
  try {
    const fileStat = await lstat(filePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null;
    return createHash("sha256")
      .update(await readFile(filePath))
      .digest("hex");
  } catch {
    return null;
  }
}

async function isRealDirectory(dirPath: string): Promise<boolean> {
  try {
    const dirStat = await lstat(dirPath);
    return dirStat.isDirectory() && !dirStat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function hasInstallLifecycleScripts(dir: string): Promise<boolean> {
  const pkgPath = join(dir, "package.json");
  if (!(await pathExists(pkgPath))) return false;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = pkg?.scripts;
    if (!scripts || typeof scripts !== "object") return false;
    return INSTALL_LIFECYCLE_SCRIPTS.some(
      (name) => typeof scripts[name] === "string" && scripts[name].trim().length > 0,
    );
  } catch {
    return true;
  }
}

async function isWorkspaceLayout(dir: string): Promise<boolean> {
  if (
    (await pathExists(join(dir, "pnpm-workspace.yaml"))) ||
    (await pathExists(join(dir, "pnpm-workspace.yml")))
  ) {
    return true;
  }
  const pkgPath = join(dir, "package.json");
  if (await pathExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { workspaces?: unknown };
      if (pkg && typeof pkg === "object" && pkg.workspaces) return true;
    } catch {
      return true;
    }
  }
  return false;
}

async function topLevelTrackedEntries(cwd: string, exec: CowExec): Promise<Set<string>> {
  const res = await exec(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, "ls-files", "-z"],
    { timeoutMs: 30_000 },
  );
  if (res.error || res.status !== 0) return new Set();
  const names = new Set<string>();
  for (const entry of res.stdout.split("\0")) {
    if (!entry) continue;
    const slash = entry.indexOf("/");
    names.add(slash === -1 ? entry : entry.slice(0, slash));
  }
  return names;
}

async function acquireSeedLock(seedDir: string): Promise<() => Promise<void>> {
  const lockDir = `${seedDir}.lock`;
  await mkdir(dirname(lockDir), { recursive: true });
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      await writeFile(join(lockDir, "pid"), `${process.pid}\n`, { mode: 0o600 });
      return async () => {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lockDir)).mtimeMs > 10 * 60_000) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Ignore stat race during stale lock cleanup.
      }
      if (Date.now() >= deadline) {
        throw new Error("cow-seed-lock-timeout", { cause: error });
      }
      await delay(100);
    }
  }
}

async function markCowSeed(seedDir: string, exec: CowExec): Promise<string> {
  const gitDir = await runGit(seedDir, ["rev-parse", "--path-format=absolute", "--git-dir"], exec);
  await writeFile(join(gitDir, COW_SEED_MARKER), `${new Date().toISOString()}\n`, { mode: 0o600 });
  return gitDir;
}

async function readSeedModulesLock(gitDir: string): Promise<string | null> {
  try {
    const value = (await readFile(join(gitDir, COW_SEED_MODULES_LOCK_MARKER), "utf8")).trim();
    return /^[0-9a-f]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeSeedModulesLock(gitDir: string, digest: string | null): Promise<void> {
  const file = join(gitDir, COW_SEED_MODULES_LOCK_MARKER);
  if (!digest) {
    await rm(file, { force: true }).catch(() => undefined);
    return;
  }
  await writeFile(file, `${digest}\n`, { mode: 0o600 });
}

async function seedNodeModules(
  cwd: string,
  seedDir: string,
  gitDir: string,
  spec: { program: string; args: string[] },
  exec: CowExec,
): Promise<void> {
  const installedLock = await fileSha256(join(cwd, "node_modules", ".pnpm", "lock.yaml"));
  const dstLock = await fileSha256(join(seedDir, "pnpm-lock.yaml"));
  const srcModules = join(cwd, "node_modules");
  if (
    !installedLock ||
    !dstLock ||
    installedLock !== dstLock ||
    !(await isRealDirectory(srcModules))
  ) {
    return;
  }
  const dstModules = join(seedDir, "node_modules");
  const cloneModules = await exec(spec.program, [...spec.args, srcModules, dstModules]);
  if (!cloneModules.error && cloneModules.status === 0) {
    const reusable =
      !(await isWorkspaceLayout(seedDir)) && !(await hasInstallLifecycleScripts(seedDir));
    await writeSeedModulesLock(gitDir, reusable ? dstLock : null);
    return;
  }
  await rm(dstModules, { recursive: true, force: true }).catch(() => undefined);
  await writeSeedModulesLock(gitDir, null);
}

async function ensureCowSeed(
  cwd: string,
  seedDir: string,
  spec: { program: string; args: string[] },
  exec: CowExec,
): Promise<{ seedHead: string; seedLock: string | null; seedHasModules: boolean }> {
  const targetCommit = await runGit(cwd, ["rev-parse", "HEAD"], exec);
  let gitDir: string;
  if (!(await pathExists(join(seedDir, ".git")))) {
    await rm(seedDir, { recursive: true, force: true });
    await runGit(cwd, ["worktree", "add", "--detach", "--quiet", seedDir, targetCommit], exec);
    gitDir = await markCowSeed(seedDir, exec);
    await seedNodeModules(cwd, seedDir, gitDir, spec, exec);
  } else {
    gitDir = await markCowSeed(seedDir, exec);
    if (await runGit(seedDir, ["status", "--porcelain"], exec)) {
      throw new Error("dirty-seed");
    }
    const currentLock = await fileSha256(join(seedDir, "pnpm-lock.yaml"));
    const installedLock = await readSeedModulesLock(gitDir);
    if (installedLock && currentLock && installedLock !== currentLock) {
      await rm(join(seedDir, "node_modules"), { recursive: true, force: true });
      await writeSeedModulesLock(gitDir, null);
    }
  }
  const seedLock = await readSeedModulesLock(gitDir);
  return {
    seedHead: await runGit(seedDir, ["rev-parse", "HEAD"], exec),
    seedLock,
    seedHasModules: Boolean(seedLock) && (await isRealDirectory(join(seedDir, "node_modules"))),
  };
}

async function cloneSeedEntries(
  seedDir: string,
  worktreePath: string,
  spec: { program: string; args: string[] },
  exec: CowExec,
): Promise<{ clonedEntries: string[]; excludedTracked: string[] }> {
  const tracked = await topLevelTrackedEntries(seedDir, exec);
  const excludedTracked = [...tracked].filter((name) => isExcludedCowEntry(name, tracked));
  const clonedEntries: string[] = [];
  for (const entry of await readdir(seedDir, { withFileTypes: true })) {
    if (isExcludedCowEntry(entry.name, tracked)) continue;
    if (entry.isSymbolicLink() && !tracked.has(entry.name)) continue;
    const src = join(seedDir, entry.name);
    const dst = join(worktreePath, entry.name);
    if (await pathExists(dst)) continue;
    const res = await exec(spec.program, [...spec.args, src, dst]);
    if (res.error || res.status !== 0) {
      throw new Error(`clone ${entry.name} failed: ${(res.stderr || res.stdout).trim()}`);
    }
    clonedEntries.push(entry.name);
  }
  return { clonedEntries, excludedTracked };
}

async function syncWorktreeTree(
  seedHead: string,
  worktreePath: string,
  excludedTracked: string[],
  exec: CowExec,
): Promise<void> {
  const targetHead = await runGit(worktreePath, ["rev-parse", "HEAD"], exec);
  const refreshArgs = [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-C",
    worktreePath,
    "update-index",
    "-q",
    "--refresh",
  ];
  if (seedHead === targetHead) {
    await runGit(worktreePath, ["read-tree", targetHead], exec);
    if (excludedTracked.length > 0) {
      await runGit(worktreePath, ["checkout", targetHead, "--", ...excludedTracked], exec);
    }
    await exec("git", refreshArgs);
  } else {
    await runGit(worktreePath, ["read-tree", seedHead], exec);
    if (excludedTracked.length > 0) {
      await runGit(worktreePath, ["checkout", seedHead, "--", ...excludedTracked], exec);
    }
    await exec("git", refreshArgs);
    await runGit(worktreePath, ["read-tree", "-m", "-u", seedHead, targetHead], exec);
  }
}

async function cleanupWorktreeSkeleton(
  cwd: string,
  worktreePath: string,
  exec: CowExec,
): Promise<void> {
  await exec("git", ["-C", cwd, "worktree", "remove", "--force", worktreePath]);
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function doesLockfileMatch(
  worktreePath: string,
  seedDir: string,
  seedInfo: { seedLock: string | null; seedHasModules: boolean },
): Promise<boolean> {
  if (
    !seedInfo.seedHasModules ||
    !seedInfo.seedLock ||
    (await isWorkspaceLayout(worktreePath)) ||
    (await isWorkspaceLayout(seedDir)) ||
    (await hasInstallLifecycleScripts(worktreePath)) ||
    (await hasInstallLifecycleScripts(seedDir)) ||
    !(await isRealDirectory(join(worktreePath, "node_modules")))
  ) {
    return false;
  }
  const wtLock = await fileSha256(join(worktreePath, "pnpm-lock.yaml"));
  const wtInstalledLock = await fileSha256(
    join(worktreePath, "node_modules", ".pnpm", "lock.yaml"),
  );
  return Boolean(
    wtLock && wtInstalledLock && seedInfo.seedLock === wtLock && wtInstalledLock === wtLock,
  );
}

export async function createWorktreeWithCowFallback(options: {
  cwd: string;
  worktreePath: string;
  addArguments: string[];
  runPlainAdd: () => Promise<void>;
  runNoCheckoutAdd: () => Promise<void>;
  seedDir?: string;
  platform?: NodeJS.Platform;
  exec?: CowExec;
  enabled?: boolean;
}): Promise<CowWorktreeMaterializeResult> {
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  const enabled = options.enabled ?? process.env.PASEO_WORKTREE_COW !== "0";

  const plain = async (fallbackReason: string): Promise<CowWorktreeMaterializeResult> => {
    await options.runPlainAdd();
    return {
      mechanism: "plain",
      fallbackReason,
      seedDir: null,
      clonedEntries: [],
      lockfileMatched: false,
    };
  };

  if (!enabled) return plain("disabled");
  const parentDir = dirname(options.worktreePath);
  const probe = await supportsReflink(parentDir, { platform, exec });
  const spec = cloneEntryCommand(platform);
  if (!probe.supported || !probe.mechanism || !spec) {
    return plain(probe.reason ?? "reflink-unsupported");
  }

  const seedDir = options.seedDir ?? join(parentDir, ".cow-seeds", "default");
  let seedInfo: { seedHead: string; seedLock: string | null; seedHasModules: boolean };
  let clonedEntries: string[];
  let excludedTracked: string[];
  let skeletonCreated = false;
  let releaseSeedLock: (() => Promise<void>) | null = null;
  try {
    await mkdir(dirname(seedDir), { recursive: true });
    if ((await stat(dirname(seedDir))).dev !== (await stat(parentDir)).dev) {
      return plain("cross-volume-seed");
    }
    releaseSeedLock = await acquireSeedLock(seedDir);
    seedInfo = await ensureCowSeed(options.cwd, seedDir, spec, exec);
    await options.runNoCheckoutAdd();
    skeletonCreated = true;
    const cloned = await cloneSeedEntries(seedDir, options.worktreePath, spec, exec);
    clonedEntries = cloned.clonedEntries;
    excludedTracked = cloned.excludedTracked;
  } catch (error) {
    if (skeletonCreated) await cleanupWorktreeSkeleton(options.cwd, options.worktreePath, exec);
    return plain(`${skeletonCreated ? "cow-failed" : "seed-failed"}:${errorMessage(error)}`);
  } finally {
    await releaseSeedLock?.();
  }

  try {
    await syncWorktreeTree(seedInfo.seedHead, options.worktreePath, excludedTracked, exec);
    return {
      mechanism: probe.mechanism,
      fallbackReason: null,
      seedDir: resolve(await realpath(seedDir)),
      clonedEntries,
      lockfileMatched: await doesLockfileMatch(options.worktreePath, seedDir, seedInfo),
    };
  } catch (error) {
    await cleanupWorktreeSkeleton(options.cwd, options.worktreePath, exec);
    return plain(`cow-failed:${errorMessage(error)}`);
  }
}
