import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import compareVersions from "semver/functions/compare.js";
import { z } from "zod";
import {
  PluginIdSchema,
  type PluginInstallation,
  type PluginSourceStatusItem,
  type PluginUpdatePreview,
  type PluginUpdateProposal,
  type PluginUpdateSelection,
  type PluginUpdateTarget,
} from "@getpaseo/protocol/messages";
import { runGitCommand } from "../../utils/run-git-command.js";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";
import { readPluginManifest, type PluginManifest } from "./manifest.js";
import { acquireNpm, isNpmSource, readNpmArtifact, resolveNpm } from "./managed-source/npm.js";

const GIT_TIMEOUT_MS = 120_000;
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" } as const;
// COMPAT(plugin-source-record): v0.8.0; accept and strip pre-correction selector/revision/root copies until daemon floor supports artifact-derived metadata.
const ManagedPluginRecordSchema = z.union([
  z.object({ kind: z.literal("git").default("git"), remote: z.string().min(1) }),
  z.object({ kind: z.literal("npm") }),
]);
export type ManagedPluginRecord = z.infer<typeof ManagedPluginRecordSchema>;
export interface ManagedPluginCandidate {
  build: PluginManifest["build"];
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
interface OwnedLocation {
  versionRoot: string;
  sourceRoot: string;
  identity: PluginInstallation["identity"];
}

export class ManagedPluginSources {
  private readonly root: string;
  private readonly metadataPath: string;
  private readonly records: Record<string, ManagedPluginRecord>;
  constructor(paseoHome: string) {
    this.root = path.resolve(paseoHome, "plugins");
    this.metadataPath = path.join(this.root, "sources.json");
    this.records = existsSync(this.metadataPath)
      ? z
          .record(PluginIdSchema, ManagedPluginRecordSchema)
          .parse(JSON.parse(readFileSync(this.metadataPath, "utf8")))
      : {};
  }

  private locate(
    pluginId: string,
    configuredPath: string,
    record = this.records[pluginId],
  ): OwnedLocation {
    if (!record) throw new Error(`Plugin is a local directory: ${pluginId}`);
    const pluginRoot = path.join(this.root, PluginIdSchema.parse(pluginId));
    const parts = path.relative(pluginRoot, path.resolve(configuredPath)).split(path.sep);
    // COMPAT(plugin-git-layout): added in v0.8.0; retain while pre-correction installations exist.
    // Git originally used <12-hex-commit>-<uuid>; the prefix is a directory name, never revision truth.
    const versionId =
      record.kind === "git" ? (parts[0] ?? "").replace(/^[0-9a-f]{12}-/, "") : (parts[0] ?? "");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(versionId) ||
      parts.some((part) => part === "..")
    )
      throw new Error(`Plugin directory is outside its managed installation: ${pluginId}`);
    const versionRoot = path.join(pluginRoot, parts[0]!);
    if (record.kind === "git") {
      if (parts[1] !== "checkout")
        throw new Error(`Invalid Git installation directory: ${pluginId}`);
      return {
        versionRoot,
        sourceRoot: path.join(versionRoot, "checkout"),
        identity: {
          kind: "git",
          remote: redactRemoteCredentials(record.remote),
          pluginPath: parts.slice(2).join("/") || ".",
        },
      };
    }
    if (parts[1] !== "node_modules" || !parts[2])
      throw new Error(`Invalid npm installation directory: ${pluginId}`);
    const packageParts = parts[2].startsWith("@") ? 2 : 1;
    const packageName = parts.slice(2, 2 + packageParts).join("/");
    if (!isNpmSource(packageName)) throw new Error(`Invalid npm package directory: ${pluginId}`);
    return {
      versionRoot,
      sourceRoot: path.join(versionRoot, "node_modules", packageName),
      identity: {
        kind: "npm",
        packageName,
        pluginPath: parts.slice(2 + packageParts).join("/") || ".",
      },
    };
  }

  async describe(pluginId: string, configuredPath: string): Promise<PluginInstallation> {
    if (!this.records[pluginId])
      return { identity: { kind: "directory", path: path.resolve(configuredPath) } };
    const location = this.locate(pluginId, configuredPath);
    try {
      return {
        identity: location.identity,
        currentRevision: await this.revision(location, configuredPath),
      };
    } catch {
      return { identity: location.identity };
    }
  }

  private async revision(location: OwnedLocation, configuredPath: string): Promise<string> {
    await assertRealContainment(this.root, location.versionRoot);
    await assertRealContainment(location.versionRoot, configuredPath);
    return location.identity.kind === "npm"
      ? (await readNpmArtifact(location.versionRoot, location.identity.packageName)).version
      : revParse(location.sourceRoot, "HEAD");
  }

  async prepareInstall(
    input: InstallInput,
    target?: PluginUpdateTarget,
  ): Promise<ManagedPluginCandidate> {
    const pluginPath = normalizePluginPath(input.pluginPath);
    const versionRoot = await this.createStagingRoot();
    try {
      let record: ManagedPluginRecord;
      let sourceRoot: string;
      if (isNpmSource(input.source)) {
        if (input.ref)
          throw new Error(
            "Plugin --ref is only valid for Git sources; use npm:package@version for npm",
          );
        const artifact = await acquireNpm(
          input.source,
          versionRoot,
          target?.kind === "npm" ? target : undefined,
        );
        sourceRoot = path.join(versionRoot, "node_modules", artifact.packageName);
        record = { kind: "npm" };
      } else {
        const remote = normalizeGitSource(input.source);
        sourceRoot = path.join(versionRoot, "checkout");
        await clone(remote, sourceRoot);
        const commit = await resolveRequestedRef(sourceRoot, input.ref);
        if (target?.kind === "git" && commit !== target.commit)
          throw new Error("Git target changed since review");
        await checkout(sourceRoot, commit);
        record = { kind: "git", remote };
      }
      const directory = path.resolve(sourceRoot, pluginPath);
      assertPluginPath(sourceRoot, directory);
      await assertRealContainment(sourceRoot, directory);
      const { id: defaultId, build } = await readPluginManifest(directory);
      return { build, defaultId, directory, record, versionRoot };
    } catch (error) {
      await rm(versionRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async place(
    pluginId: string,
    candidate: ManagedPluginCandidate,
  ): Promise<ManagedPluginCandidate> {
    const pluginRoot = path.join(this.root, PluginIdSchema.parse(pluginId));
    ensurePrivateDirectory(pluginRoot);
    await assertRealContainment(this.root, pluginRoot);
    const versionRoot = path.join(pluginRoot, randomUUID());
    const relativeDirectory = path.relative(candidate.versionRoot, candidate.directory);
    await rename(candidate.versionRoot, versionRoot);
    return { ...candidate, directory: path.join(versionRoot, relativeDirectory), versionRoot };
  }

  async preview(
    pluginId: string,
    configuredPath: string,
    selection?: PluginUpdateSelection,
  ): Promise<PluginUpdatePreview> {
    const current = await this.describe(pluginId, configuredPath);
    if (current.identity.kind === "directory") {
      if (selection) throw new Error(`Plugin is a local directory: ${pluginId}`);
      return { id: pluginId, outcome: "local", current, links: [] };
    }
    if (!current.currentRevision)
      throw new Error(
        `Installed revision is unavailable for ${pluginId}; restore its acquisition artifacts before updating`,
      );
    if (selection && selection.kind !== current.identity.kind)
      throw new Error(`Update target does not match ${current.identity.kind} source: ${pluginId}`);
    const location = this.locate(pluginId, configuredPath);
    let target: PluginUpdateTarget;
    let outcome: PluginUpdatePreview["outcome"];
    if (current.identity.kind === "npm") {
      target = {
        kind: "npm",
        ...(await resolveNpm(
          current.identity.packageName,
          selection?.kind === "npm" ? selection.version : "latest",
          this.root,
        )),
      };
      const comparison = compareVersions(target.version, current.currentRevision);
      if (comparison === 0) outcome = "current";
      else if (comparison < 0 && !selection) outcome = "installed-newer";
      else outcome = "update";
    } else {
      const record = this.records[pluginId];
      if (record?.kind !== "git") throw new Error("Git source is no longer configured");
      target = {
        kind: "git",
        commit: await resolveRemoteCommit(
          record.remote,
          this.root,
          selection?.kind === "git" ? selection.ref : undefined,
        ),
      };
      outcome = target.commit === current.currentRevision ? "current" : "update";
    }
    const links = reviewLinks(current, target);
    return {
      id: pluginId,
      outcome,
      current,
      target,
      links,
      ...(outcome === "update"
        ? {
            proposal: {
              id: pluginId,
              expected: {
                identity: current.identity,
                installationRoot: location.versionRoot,
                revision: current.currentRevision,
              },
              target,
            },
          }
        : {}),
    };
  }

  async assertCurrent(proposal: PluginUpdateProposal, configuredPath: string): Promise<void> {
    const current = await this.describe(proposal.id, configuredPath);
    const location = this.locate(proposal.id, configuredPath);
    if (
      !isDeepStrictEqual(current.identity, proposal.expected.identity) ||
      current.currentRevision !== proposal.expected.revision ||
      location.versionRoot !== proposal.expected.installationRoot
    )
      throw new Error(`Plugin ${proposal.id} changed since review; check again`);
    if (proposal.target.kind !== current.identity.kind)
      throw new Error("Update target does not match the installed source");
  }

  async prepareUpdate(
    proposal: PluginUpdateProposal,
    configuredPath: string,
  ): Promise<ManagedPluginCandidate> {
    await this.assertCurrent(proposal, configuredPath);
    const identity = this.locate(proposal.id, configuredPath).identity;
    const record = this.records[proposal.id];
    if (identity.kind === "git" && record?.kind === "git" && proposal.target.kind === "git")
      return this.prepareInstall(
        {
          source: `git:${record.remote}`,
          ref: proposal.target.commit,
          pluginPath: identity.pluginPath,
        },
        proposal.target,
      );
    if (identity.kind === "npm" && proposal.target.kind === "npm")
      return this.prepareInstall(
        {
          source: `npm:${identity.packageName}@${proposal.target.version}`,
          pluginPath: identity.pluginPath,
        },
        proposal.target,
      );
    throw new Error("Update target does not match the installed source");
  }

  async verifyCandidate(
    pluginId: string,
    candidate: ManagedPluginCandidate,
    target?: PluginUpdateTarget,
  ): Promise<void> {
    const location = this.locate(pluginId, candidate.directory, candidate.record);
    const revision = await this.revision(location, candidate.directory);
    if (target?.kind === "git" && revision !== target.commit)
      throw new Error("Preparation changed the reviewed Git commit");
    if (target?.kind === "npm" && location.identity.kind === "npm") {
      const artifact = await readNpmArtifact(location.versionRoot, location.identity.packageName);
      if (
        artifact.version !== target.version ||
        artifact.integrity !== target.integrity ||
        artifact.resolved !== target.resolved
      )
        throw new Error("Preparation changed the reviewed npm artifact");
    }
  }

  async status(pluginId: string, configuredPath: string): Promise<PluginSourceStatusItem> {
    const preview = await this.preview(pluginId, configuredPath);
    const installation = preview.current!;
    return {
      id: pluginId,
      source: installation.identity.kind === "git" ? "git" : "directory",
      path: configuredPath,
      installation,
      ...(installation.identity.kind === "git"
        ? {
            remote: installation.identity.remote,
            currentCommit: installation.currentRevision,
            latestCommit: preview.target?.kind === "git" ? preview.target.commit : undefined,
            updateAvailable: preview.outcome === "update",
          }
        : {}),
    };
  }

  commit(pluginId: string, record: ManagedPluginRecord): void {
    this.records[pluginId] = ManagedPluginRecordSchema.parse(record);
    this.writeRecords();
  }
  async discard(candidate: ManagedPluginCandidate): Promise<void> {
    await rm(candidate.versionRoot, { recursive: true, force: true });
  }
  async removeVersion(pluginId: string, configuredPath: string): Promise<void> {
    const location = this.locate(pluginId, configuredPath);
    await assertRealContainment(this.root, path.dirname(location.versionRoot));
    await rm(location.versionRoot, { recursive: true, force: true });
  }
  async remove(pluginId: string): Promise<void> {
    if (!this.records[pluginId]) return;
    const pluginRoot = path.join(this.root, PluginIdSchema.parse(pluginId));
    if (existsSync(pluginRoot)) {
      await assertRealContainment(this.root, pluginRoot);
      await rm(pluginRoot, { recursive: true, force: true });
    }
    delete this.records[pluginId];
    this.writeRecords();
  }
  private async createStagingRoot(): Promise<string> {
    const stagingRoot = path.join(this.root, ".staging", randomUUID());
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await assertRealContainment(this.root, stagingRoot);
    return stagingRoot;
  }
  private writeRecords(): void {
    writePrivateFileAtomicSync(this.metadataPath, `${JSON.stringify(this.records, null, 2)}\n`);
  }
}

async function assertRealContainment(root: string, directory: string): Promise<void> {
  assertPluginPath(await realpath(root), await realpath(directory));
}
function reviewLinks(current: PluginInstallation, target: PluginUpdateTarget): string[] {
  if (
    current.identity.kind === "npm" &&
    target.kind === "npm" &&
    new URL(target.resolved).hostname === "registry.npmjs.org"
  )
    return [current.currentRevision, target.version].map(
      (version) =>
        `https://www.npmjs.com/package/${current.identity.kind === "npm" ? current.identity.packageName : ""}/v/${encodeURIComponent(version!)}`,
    );
  if (current.identity.kind !== "git" || target.kind !== "git") return [];
  const remote = current.identity.remote
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/(?:git@)?/, "https://")
    .replace(/\.git$/, "");
  try {
    const url = new URL(remote);
    if (url.hostname === "github.com")
      return [`${url.origin}${url.pathname}/compare/${current.currentRevision}...${target.commit}`];
    if (url.hostname === "gitlab.com")
      return [
        `${url.origin}${url.pathname}/-/compare/${current.currentRevision}...${target.commit}`,
      ];
  } catch {
    /* Local remotes have no review website. */
  }
  return [];
}
function normalizeGitSource(source: string): string {
  if (source.startsWith("github:")) {
    const shorthand = source.slice(7);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(shorthand)) {
      throw new Error("Use github:owner/repository for a GitHub plugin source");
    }
    source = shorthand;
  } else if (source.startsWith("git:") && !source.startsWith("git://")) {
    source = source.slice(4);
  }
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
    throw new Error("Plugin path must be relative to the repository");
  const normalized = path.normalize(pluginPath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Plugin path must stay inside the repository");
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
): Promise<string> {
  if (!requestedRef) return revParse(checkoutRoot, "refs/remotes/origin/HEAD^{commit}");
  if (requestedRef.startsWith("-")) throw new Error("Plugin Git ref cannot start with '-'");
  for (const ref of [
    `refs/remotes/origin/${requestedRef}`,
    `refs/tags/${requestedRef}`,
    requestedRef,
  ]) {
    if (await refExists(checkoutRoot, ref)) return revParse(checkoutRoot, `${ref}^{commit}`);
  }
  return revParse(checkoutRoot, `${requestedRef}^{commit}`);
}
async function resolveRemoteCommit(remote: string, cwd: string, ref?: string): Promise<string> {
  if (ref?.startsWith("-")) throw new Error("Plugin Git ref cannot start with '-'");
  if (ref && /^[0-9a-f]{40,64}$/.test(ref)) return ref;
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
    const names = ref
      ? [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`, ref]
      : ["HEAD"];
    const { stdout } = await runGitCommand(["ls-remote", "--symref", "--", cloneRemote, ...names], {
      cwd,
      envOverlay,
      timeout: GIT_TIMEOUT_MS,
    });
    const entries = new Map(
      stdout
        .trim()
        .split("\n")
        .map((line) => {
          const [commit, name] = line.split("\t");
          return [name, commit];
        }),
    );
    for (const name of names) {
      const commit = entries.get(name);
      if (commit && /^[0-9a-f]{40,64}$/.test(commit)) return commit;
    }
    if (ref) {
      // Abbreviated commits and revision expressions are not advertised by ls-remote.
      // Resolve them in a temporary object database without preparing or touching the installed plugin.
      const staging = path.join(cwd, ".staging", randomUUID());
      await mkdir(staging, { recursive: true, mode: 0o700 });
      try {
        await clone(remote, path.join(staging, "checkout"));
        return await resolveRequestedRef(path.join(staging, "checkout"), ref);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    throw new Error("Cannot resolve Git default HEAD");
  } catch (error) {
    throw redactRemoteError(error, remote);
  }
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
