import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PluginIdSchema, type PluginSourceStatusItem } from "@getpaseo/protocol/messages";
import { runGitCommand } from "../../utils/run-git-command.js";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";
import { readPluginManifest } from "./manifest.js";

const GIT_TIMEOUT_MS = 120_000;
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" } as const;

const ManagedPluginRecordSchema = z
  .object({
    remote: z.string().min(1),
    requestedRef: z.string().min(1).nullable(),
    trackingBranch: z.string().min(1).nullable(),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    pluginPath: z.string(),
    checkoutRoot: z.string().min(1),
  })
  .strict();

const ManagedPluginRecordsSchema = z.record(PluginIdSchema, ManagedPluginRecordSchema);

export interface ManagedPluginRecord extends z.infer<typeof ManagedPluginRecordSchema> {}

export interface ManagedPluginCandidate {
  defaultId: string;
  directory: string;
  record: ManagedPluginRecord;
  versionRoot: string;
}

interface InstallInput {
  source: string;
  ref?: string;
  pluginPath?: string;
}

interface RefResolution {
  commit: string;
  requestedRef: string | null;
  trackingBranch: string | null;
}

export class ManagedPluginSources {
  private readonly root: string;
  private readonly metadataPath: string;
  private readonly records: Record<string, ManagedPluginRecord>;

  constructor(paseoHome: string) {
    this.root = path.join(paseoHome, "plugins");
    this.metadataPath = path.join(this.root, "sources.json");
    this.records = this.readRecords();
  }

  get(pluginId: string): ManagedPluginRecord | null {
    return this.records[pluginId] ?? null;
  }

  displayRemote(pluginId: string): string | null {
    const remote = this.records[pluginId]?.remote;
    return remote ? redactRemoteCredentials(remote) : null;
  }

  async prepareInstall(input: InstallInput): Promise<ManagedPluginCandidate> {
    const remote = normalizeGitSource(input.source);
    const pluginPath = normalizePluginPath(input.pluginPath);
    const stagingRoot = await this.createStagingRoot();
    try {
      const checkoutRoot = path.join(stagingRoot, "checkout");
      await clone(remote, checkoutRoot);
      const resolution = await resolveRequestedRef(checkoutRoot, input.ref);
      await checkout(checkoutRoot, resolution.commit);
      const directory = path.resolve(checkoutRoot, pluginPath);
      assertPluginPath(checkoutRoot, directory);
      const { id: defaultId } = await readPluginManifest(directory);
      return {
        defaultId,
        directory,
        record: {
          remote,
          requestedRef: resolution.requestedRef,
          trackingBranch: resolution.trackingBranch,
          commit: resolution.commit,
          pluginPath,
          checkoutRoot,
        },
        versionRoot: stagingRoot,
      };
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async place(
    pluginId: string,
    candidate: ManagedPluginCandidate,
  ): Promise<ManagedPluginCandidate> {
    const pluginRoot = path.join(this.root, pluginId);
    ensurePrivateDirectory(pluginRoot);
    const versionRoot = path.join(
      pluginRoot,
      `${candidate.record.commit.slice(0, 12)}-${randomUUID()}`,
    );
    await rename(candidate.versionRoot, versionRoot);
    const checkoutRoot = path.join(versionRoot, "checkout");
    const directory = path.resolve(checkoutRoot, candidate.record.pluginPath);
    return {
      ...candidate,
      directory,
      versionRoot,
      record: { ...candidate.record, checkoutRoot },
    };
  }

  async status(pluginId: string, configuredPath: string): Promise<PluginSourceStatusItem> {
    const record = this.records[pluginId];
    if (!record) return { id: pluginId, source: "directory", path: configuredPath };
    if (!record.trackingBranch) {
      return {
        id: pluginId,
        source: "git",
        path: configuredPath,
        remote: redactRemoteCredentials(record.remote),
        ref: record.requestedRef ?? record.commit,
        currentCommit: record.commit,
        latestCommit: record.commit,
        commitsBehind: 0,
        updateAvailable: false,
      };
    }
    await fetchOrigin(record.checkoutRoot);
    const latestCommit = await revParse(
      record.checkoutRoot,
      `refs/remotes/origin/${record.trackingBranch}^{commit}`,
    );
    const commitsBehind = await countCommits(record.checkoutRoot, record.commit, latestCommit);
    return {
      id: pluginId,
      source: "git",
      path: configuredPath,
      remote: redactRemoteCredentials(record.remote),
      ref: record.requestedRef ?? record.trackingBranch,
      currentCommit: record.commit,
      latestCommit,
      commitsBehind,
      updateAvailable: latestCommit !== record.commit,
    };
  }

  async prepareUpdate(
    pluginId: string,
    configuredPath: string,
  ): Promise<{ candidate: ManagedPluginCandidate | null; commits: number }> {
    const record = this.records[pluginId];
    if (!record) throw new Error(`Plugin is not managed by Git: ${pluginId}`);
    const status = await this.status(pluginId, configuredPath);
    const latestCommit = status.latestCommit;
    if (!latestCommit || latestCommit === record.commit) return { candidate: null, commits: 0 };
    const candidate = await this.prepareCommit(record, latestCommit);
    return { candidate, commits: status.commitsBehind ?? 0 };
  }

  commit(pluginId: string, record: ManagedPluginRecord): void {
    this.records[pluginId] = record;
    this.writeRecords();
  }

  async discard(candidate: ManagedPluginCandidate): Promise<void> {
    await rm(candidate.versionRoot, { recursive: true, force: true });
  }

  async removeVersion(record: ManagedPluginRecord): Promise<void> {
    const versionRoot = path.dirname(record.checkoutRoot);
    const pluginRoot = path.dirname(versionRoot);
    const expectedRoot = path.resolve(this.root);
    if (path.dirname(pluginRoot) !== expectedRoot) {
      throw new Error(
        `Managed plugin checkout is outside the plugin store: ${record.checkoutRoot}`,
      );
    }
    await rm(versionRoot, { recursive: true, force: true });
  }

  async remove(pluginId: string): Promise<void> {
    if (!this.records[pluginId]) return;
    delete this.records[pluginId];
    this.writeRecords();
    await rm(path.join(this.root, pluginId), { recursive: true, force: true });
  }

  private async prepareCommit(
    record: ManagedPluginRecord,
    commit: string,
  ): Promise<ManagedPluginCandidate> {
    const stagingRoot = await this.createStagingRoot();
    try {
      const checkoutRoot = path.join(stagingRoot, "checkout");
      await clone(record.remote, checkoutRoot);
      const resolvedCommit = await revParse(checkoutRoot, `${commit}^{commit}`);
      if (resolvedCommit !== commit)
        throw new Error(`Git source no longer contains commit ${commit}`);
      await checkout(checkoutRoot, commit);
      const directory = path.resolve(checkoutRoot, record.pluginPath);
      assertPluginPath(checkoutRoot, directory);
      const { id: defaultId } = await readPluginManifest(directory);
      return {
        defaultId,
        directory,
        versionRoot: stagingRoot,
        record: { ...record, commit, checkoutRoot },
      };
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }

  private async createStagingRoot(): Promise<string> {
    const stagingRoot = path.join(this.root, ".staging", randomUUID());
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    return stagingRoot;
  }

  private readRecords(): Record<string, ManagedPluginRecord> {
    if (!existsSync(this.metadataPath)) return {};
    return ManagedPluginRecordsSchema.parse(JSON.parse(readFileSync(this.metadataPath, "utf8")));
  }

  private writeRecords(): void {
    writePrivateFileAtomicSync(this.metadataPath, `${JSON.stringify(this.records, null, 2)}\n`);
  }
}

function normalizeGitSource(source: string): string {
  const github = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(source);
  if (github) {
    const repository = github[2].replace(/\.git$/, "");
    return `https://github.com/${github[1]}/${repository}.git`;
  }
  const isUrl = /^(?:https?|ssh|git|file):\/\//.test(source);
  const isScpStyle = /^[^/@\s]+@[^:\s]+:.+$/.test(source);
  if (isUrl || isScpStyle) return source;
  throw new Error(`Plugin source is neither an existing directory nor a Git URL: ${source}`);
}

function redactRemoteCredentials(remote: string): string {
  if (!/^(?:https?|ssh|git|file):\/\//.test(remote)) return remote;
  const url = new URL(remote);
  url.username = "";
  url.password = "";
  return url.href;
}

function normalizePluginPath(pluginPath: string | undefined): string {
  if (!pluginPath || pluginPath === ".") return ".";
  if (path.isAbsolute(pluginPath))
    throw new Error("Plugin --path must be relative to the repository");
  const normalized = path.normalize(pluginPath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Plugin --path must stay inside the repository");
  }
  return normalized;
}

function assertPluginPath(checkoutRoot: string, directory: string): void {
  const relative = path.relative(checkoutRoot, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Plugin path escapes the repository");
  }
}

async function clone(remote: string, checkoutRoot: string): Promise<void> {
  const publicRemote = redactRemoteCredentials(remote);
  const cloneRemote = publicRemote === remote ? remote : "https://paseo.invalid/plugin.git";
  const envOverlay =
    cloneRemote === remote
      ? GIT_ENV
      : {
          ...GIT_ENV,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
          GIT_CONFIG_VALUE_0: cloneRemote,
        };
  try {
    await runGitCommand(["clone", "--no-checkout", "--", cloneRemote, checkoutRoot], {
      cwd: path.dirname(checkoutRoot),
      envOverlay,
      timeout: GIT_TIMEOUT_MS,
    });
  } catch (error) {
    throw redactRemoteError(error, remote);
  }
}

function redactRemoteError(error: unknown, remote: string): Error {
  let message = error instanceof Error ? error.message : String(error);
  const publicRemote = redactRemoteCredentials(remote);
  message = message.split(remote).join(publicRemote);
  if (!/^(?:https?|ssh|git|file):\/\//.test(remote)) return new Error(message);
  const url = new URL(remote);
  for (const credential of [url.username, url.password]) {
    if (!credential) continue;
    message = message.split(credential).join("[redacted]");
    let decoded = credential;
    try {
      decoded = decodeURIComponent(credential);
    } catch {
      // URL credentials can contain a literal percent sign.
    }
    if (decoded !== credential) message = message.split(decoded).join("[redacted]");
  }
  return new Error(message);
}

async function checkout(checkoutRoot: string, commit: string): Promise<void> {
  await runGitCommand(["checkout", "--detach", commit], {
    cwd: checkoutRoot,
    envOverlay: GIT_ENV,
    timeout: GIT_TIMEOUT_MS,
  });
  await runGitCommand(["submodule", "update", "--init", "--recursive"], {
    cwd: checkoutRoot,
    envOverlay: GIT_ENV,
    timeout: GIT_TIMEOUT_MS,
  });
}

async function resolveRequestedRef(
  checkoutRoot: string,
  requestedRef: string | undefined,
): Promise<RefResolution> {
  if (!requestedRef) {
    const { stdout } = await runGitCommand(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { cwd: checkoutRoot },
    );
    const trackingBranch = stdout.trim().replace(/^origin\//, "");
    const commit = await revParse(checkoutRoot, `refs/remotes/origin/${trackingBranch}^{commit}`);
    return { commit, requestedRef: null, trackingBranch };
  }
  if (requestedRef.startsWith("-")) throw new Error("Plugin Git ref cannot start with '-'");
  const branchRef = `refs/remotes/origin/${requestedRef}`;
  if (await refExists(checkoutRoot, branchRef)) {
    const commit = await revParse(checkoutRoot, `${branchRef}^{commit}`);
    return { commit, requestedRef, trackingBranch: requestedRef };
  }
  const tagRef = `refs/tags/${requestedRef}`;
  if (await refExists(checkoutRoot, tagRef)) {
    const commit = await revParse(checkoutRoot, `${tagRef}^{commit}`);
    return { commit, requestedRef, trackingBranch: null };
  }
  const commit = await revParse(checkoutRoot, `${requestedRef}^{commit}`);
  return { commit, requestedRef, trackingBranch: null };
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const result = await runGitCommand(["show-ref", "--verify", "--quiet", ref], {
    cwd,
    acceptExitCodes: [0, 1],
  });
  return result.exitCode === 0;
}

async function revParse(cwd: string, ref: string): Promise<string> {
  const { stdout } = await runGitCommand(["rev-parse", "--verify", ref], { cwd });
  return stdout.trim();
}

async function fetchOrigin(cwd: string): Promise<void> {
  await runGitCommand(["fetch", "--prune", "--tags", "origin"], {
    cwd,
    envOverlay: GIT_ENV,
    timeout: GIT_TIMEOUT_MS,
  });
}

async function countCommits(cwd: string, current: string, latest: string): Promise<number> {
  if (current === latest) return 0;
  const { stdout } = await runGitCommand(["rev-list", "--count", `${current}..${latest}`], { cwd });
  return Number.parseInt(stdout.trim(), 10);
}
