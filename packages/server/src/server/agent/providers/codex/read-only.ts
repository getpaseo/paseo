import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { resolvePaseoHome } from "../../../paseo-home.js";
import { assertWritePolicySupported } from "../../write-policy.js";

export const READ_ONLY_CODEX_FLAGS = [
  "-c",
  'sandbox_mode="danger-full-access"',
  "-c",
  'approval_policy="never"',
  "-c",
  'cli_auth_credentials_store="file"',
  "-c",
  "features.apps=false",
  "-c",
  "features.enable_mcp_apps=false",
  "-c",
  "features.plugins=false",
  "-c",
  "features.hooks=false",
  "-c",
  "features.skill_mcp_dependency_install=false",
  "-c",
  "features.multi_agent=false",
  "-c",
  "features.multi_agent_v2=false",
];

function readOnlyStatePath(agentId: string, stateRoot?: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) throw new Error("Invalid read-only state owner");
  return join(stateRoot ?? join(resolvePaseoHome(), "codex-read-only"), agentId);
}

export async function removeReadOnlyCodexState(agentId: string, stateRoot?: string): Promise<void> {
  await removeReadOnlyStateEntry(agentId, stateRoot, false);
}

export async function cleanupReadOnlyCodexTemp(agentId: string, stateRoot?: string): Promise<void> {
  await removeReadOnlyStateEntry(agentId, stateRoot, true);
}

async function readOnlyDirectoryExists(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Unsafe read-only state directory");
    }
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function removeReadOnlyStateEntry(
  agentId: string,
  stateRoot: string | undefined,
  temporary: boolean,
): Promise<void> {
  const rootPath = dirname(readOnlyStatePath(agentId, stateRoot));
  if (!(await readOnlyDirectoryExists(rootPath))) return;
  const root = await realpath(rootPath);
  const owner = join(root, agentId);
  if (!(await readOnlyDirectoryExists(owner))) return;
  // The OS policy freezes owner itself. Move mutable contents out of every
  // provider's writable boundary before recursive traversal, including on crash.
  const quarantine = await mkdtemp(join(root, ".cleanup-"));
  try {
    await rename(temporary ? join(owner, "tmp") : owner, join(quarantine, "removed"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  } finally {
    await rm(quarantine, { recursive: true, force: true });
  }
}

export async function prepareReadOnlyCodexRuntime(input: {
  agentId?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stateRoot?: string;
}): Promise<{ profile: string; stateDir: string; env: NodeJS.ProcessEnv }> {
  assertWritePolicySupported({ provider: "codex", writePolicy: "read_only" });
  if (!input.agentId || !/^[a-zA-Z0-9_-]+$/.test(input.agentId)) {
    throw new Error("read_only requires a stable Paseo agent ID");
  }
  const stateRoot = input.stateRoot ?? join(resolvePaseoHome(), "codex-read-only");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await readOnlyDirectoryExists(stateRoot);
  const root = await realpath(stateRoot);
  const statePath = join(root, input.agentId);
  await mkdir(statePath, { mode: 0o700, recursive: true });
  const stateDir = await realpath(statePath);
  const cwd = await realpath(input.cwd);
  const fromWorkspace = relative(cwd, stateDir);
  if (
    stateDir !== statePath ||
    (fromWorkspace !== ".." && !fromWorkspace.startsWith(`..${sep}`) && !isAbsolute(fromWorkspace))
  ) {
    throw new Error("read_only state must be a private directory outside the workspace");
  }
  const tempDir = join(stateDir, "tmp");
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  if ((await realpath(tempDir)) !== tempDir) {
    throw new Error("read_only temp directory must not be a symlink");
  }
  const sourceHome = input.env.CODEX_HOME ?? join(homedir(), ".codex");
  if (sourceHome !== stateDir) {
    try {
      // Never follow/overwrite a destination supplied by a previous session.
      await copyFile(
        join(sourceHome, "auth.json"),
        join(stateDir, "auth.json"),
        constants.COPYFILE_EXCL,
      );
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "EEXIST")
        )
      )
        throw error;
    }
  }
  const paseoHome = await realpath(resolvePaseoHome()).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return resolvePaseoHome();
    throw error;
  });
  const env: NodeJS.ProcessEnv = { ...input.env, CODEX_HOME: stateDir, TMPDIR: tempDir };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PASEO_") || key.startsWith("DYLD_")) delete env[key];
  }
  // macOS cannot nest the native sandbox in an already confined process.
  // Descendants inherit this boundary, including exec-policy-approved commands.
  const profile = `(version 1)
(deny default)
(allow file-read*)
(deny file-read* (subpath ${JSON.stringify(paseoHome)}))
(allow file-read-metadata (literal ${JSON.stringify(paseoHome)}) (literal ${JSON.stringify(root)}))
(allow file-read* (subpath ${JSON.stringify(stateDir)}))
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(allow file-write* (subpath ${JSON.stringify(stateDir)}))
(deny file-write* (literal ${JSON.stringify(stateDir)}))
(deny file-write* (literal ${JSON.stringify(join(stateDir, "config.toml"))}))
(allow file-write-data (literal "/dev/null"))
(allow network-outbound (remote tcp "*:443"))
(deny network-outbound (remote ip "localhost:*"))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership") (global-name "com.apple.networkd") (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.SystemConfiguration.configd"))`;
  return { profile, stateDir, env };
}
