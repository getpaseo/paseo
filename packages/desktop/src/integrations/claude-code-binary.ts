// Hubcode Agent backend: isolated install of Node.js + @anthropic-ai/claude-code.
//
// The Hubcode agent (provider id "hubcode") spawns the Claude Code CLI with
// ANTHROPIC_BASE_URL pointed at OmniRoute (/v1/messages). Anthropic documents
// this gateway pattern at code.claude.com/docs/en/llm-gateway, so we are not
// going off-script — same mechanism LiteLLM/Ollama/vLLM use.
//
// We install Node + claude-code into ${userData} so:
//   1. We never touch the user's global node/claude installs.
//   2. Removing Hubcode cleans up everything.
//   3. Pinned versions can't drift under us.
//
// Layout:
//   ${userData}/
//     runtime/
//       node-v22.11.0/        <- extracted Node distribution
//         bin/node            <- *nix
//         node.exe            <- windows (at root)
//     claude/
//       node_modules/
//         @anthropic-ai/claude-code/...
//         .bin/claude         <- the CLI we spawn
//       package.json          <- pins the version
//     claude-home/            <- isolated CLAUDE_HOME for spawn
//
// Public API:
//   ensureNodeRuntime()  -> resolves a Node binary; downloads if missing.
//   ensureClaudeCode()   -> npm-installs pinned claude-code into ${userData}/claude.
//   getClaudeCodeStatus() -> { installed, version, claudeBinary, nodeBinary }.

import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import log from "electron-log/main";
import * as tar from "tar";

// ---------------------------------------------------------------------------
// Pinned versions
// ---------------------------------------------------------------------------

/** Latest stable claude-code on npm at the time of pinning (resolved 2026-04-27). */
const PINNED_CLAUDE_CODE_VERSION = "2.1.119";

/**
 * Active Node LTS line. Bumping this requires re-testing the spawn flow.
 * Claude Code declares engines.node ">=18", so 22 LTS is well within range.
 */
const PINNED_NODE_VERSION = "22.11.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeCodeStatus {
  installed: boolean;
  /** Pinned version we attempt to install. */
  pinnedVersion: string;
  /** Version actually present on disk (read from package.json), if installed. */
  installedVersion: string | null;
  /** Absolute path to the claude binary, regardless of installed state. */
  claudeBinary: string;
  /** Absolute path to the node binary used to launch claude. */
  nodeBinary: string | null;
}

/**
 * Granular progress phases. The renderer maps these to user-facing copy.
 * Order roughly: idle → checking → downloading-node → extracting-node →
 * installing-claude-code → complete (or error at any step).
 */
export type ClaudeCodeInstallPhase =
  | "idle"
  | "checking"
  | "downloading-node"
  | "extracting-node"
  | "installing-claude-code"
  | "complete"
  | "error";

export interface ClaudeCodeInstallProgress {
  phase: ClaudeCodeInstallPhase;
  /** Bytes downloaded so far (only set during `downloading-node`). */
  bytesDownloaded?: number;
  /** Total bytes for the current download (may be undefined if server omits Content-Length). */
  bytesTotal?: number;
  /** Free-form human label for the current step (e.g. "Downloading Node v22.11.0"). */
  label?: string;
  /** Error message when phase === "error". */
  error?: string;
}

export type ClaudeCodeProgressReporter = (progress: ClaudeCodeInstallProgress) => void;

interface EnsureOpts {
  onProgress?: ClaudeCodeProgressReporter;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getRuntimeRoot(): string {
  return path.join(app.getPath("userData"), "runtime");
}

function getNodeInstallDir(): string {
  return path.join(getRuntimeRoot(), `node-v${PINNED_NODE_VERSION}`);
}

function getNodeBinaryPath(): string {
  if (process.platform === "win32") {
    return path.join(getNodeInstallDir(), "node.exe");
  }
  return path.join(getNodeInstallDir(), "bin", "node");
}

function getNpmCliPath(): string {
  // The Node tarball ships npm under lib/node_modules/npm/bin/npm-cli.js on
  // every platform. We invoke it directly via `node npm-cli.js ...` so we
  // don't depend on shell wrappers or PATH setup.
  return path.join(getNodeInstallDir(), "lib", "node_modules", "npm", "bin", "npm-cli.js");
}

function getClaudeInstallDir(): string {
  return path.join(app.getPath("userData"), "claude");
}

function getClaudeBinaryPath(): string {
  const dir = path.join(getClaudeInstallDir(), "node_modules", ".bin");
  return path.join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
}

export function getClaudeHomeDir(): string {
  // Isolated CLAUDE_HOME for spawn — keeps Hubcode's claude-code separate from
  // the user's personal ~/.claude (settings, MCP servers, API key, etc.).
  return path.join(app.getPath("userData"), "claude-home");
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Node download + extract
// ---------------------------------------------------------------------------

interface NodeAsset {
  url: string;
  /** Top-level directory inside the archive (e.g. "node-v22.11.0-darwin-arm64"). */
  topDir: string;
  format: "tar.gz" | "zip";
}

function resolveNodeAsset(): NodeAsset {
  const v = PINNED_NODE_VERSION;
  const arch = process.arch;
  const platform = process.platform;

  // Map Node.js distribution naming. See https://nodejs.org/dist/.
  let osPart: string;
  let archPart: string;
  let format: "tar.gz" | "zip";

  if (platform === "darwin") {
    osPart = "darwin";
    archPart = arch === "arm64" ? "arm64" : "x64";
    format = "tar.gz";
  } else if (platform === "linux") {
    osPart = "linux";
    archPart = arch === "arm64" ? "arm64" : arch === "arm" ? "armv7l" : "x64";
    format = "tar.gz";
  } else if (platform === "win32") {
    osPart = "win";
    archPart = arch === "arm64" ? "arm64" : "x64";
    format = "zip";
  } else {
    throw new Error(`Unsupported platform for Node runtime: ${platform}/${arch}`);
  }

  const topDir = `node-v${v}-${osPart}-${archPart}`;
  const ext = format === "tar.gz" ? "tar.gz" : "zip";
  return {
    url: `https://nodejs.org/dist/v${v}/${topDir}.${ext}`,
    topDir,
    format,
  };
}

function downloadToFile(
  url: string,
  dest: string,
  onProgress?: (bytesDownloaded: number, bytesTotal: number | undefined) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const fail = (err: unknown) => {
      file.close();
      fs.unlink(dest).catch(() => undefined);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    https
      .get(url, (res) => {
        // Follow up to 5 redirects.
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(dest).catch(() => undefined);
          resolve(downloadToFile(res.headers.location, dest, onProgress));
          return;
        }
        if (res.statusCode !== 200) {
          fail(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        const contentLength = res.headers["content-length"];
        const total = contentLength ? Number(contentLength) : undefined;
        let bytes = 0;
        // Throttle progress emissions to ~10 per second so we don't flood
        // the renderer with hundreds of IPC messages on fast connections.
        let lastEmitAt = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          const now = Date.now();
          if (onProgress && now - lastEmitAt > 100) {
            onProgress(bytes, total);
            lastEmitAt = now;
          }
        });
        res.pipe(file);
        file.on("finish", () =>
          file.close(() => {
            // Final emit so the bar reaches 100% even if the last chunk fell
            // inside the throttle window.
            onProgress?.(bytes, total);
            resolve();
          }),
        );
        file.on("error", fail);
      })
      .on("error", fail);
  });
}

async function extractTarGz(archivePath: string, destParent: string, expectedTopDir: string): Promise<string> {
  await fs.mkdir(destParent, { recursive: true });
  await tar.x({
    file: archivePath,
    cwd: destParent,
  });
  const extracted = path.join(destParent, expectedTopDir);
  if (!(await pathExists(extracted))) {
    throw new Error(`Extracted archive missing expected top-level directory: ${expectedTopDir}`);
  }
  return extracted;
}

async function extractZip(archivePath: string, destParent: string, expectedTopDir: string): Promise<string> {
  // Windows .zip extraction via PowerShell's Expand-Archive — ships with
  // every supported Windows version, no extra deps. We avoid pulling a
  // heavy unzip lib (unzipper, adm-zip) since Windows is the only platform
  // that needs zip support; the rest use tar.
  await fs.mkdir(destParent, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    // -Force overwrites if a partial extraction was left behind from a
    // previous failed run. We extract into destParent and then verify the
    // expected top-dir exists below.
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} ` +
        `-DestinationPath ${JSON.stringify(destParent)} -Force`,
    ];
    const child = spawn("powershell.exe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Expand-Archive exited ${code}: ${stderr.trim() || "(no stderr)"}`)),
    );
  });
  const extracted = path.join(destParent, expectedTopDir);
  if (!(await pathExists(extracted))) {
    throw new Error(`Extracted archive missing expected top-level directory: ${expectedTopDir}`);
  }
  return extracted;
}

async function downloadAndInstallNode(opts: EnsureOpts = {}): Promise<string> {
  const asset = resolveNodeAsset();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hubcode-node-"));
  const archive = path.join(tmpDir, `node.${asset.format === "tar.gz" ? "tar.gz" : "zip"}`);

  log.info(`[claude-code] Downloading Node ${PINNED_NODE_VERSION} from ${asset.url}`);
  opts.onProgress?.({
    phase: "downloading-node",
    label: `Downloading Node.js ${PINNED_NODE_VERSION}`,
    bytesDownloaded: 0,
  });
  await downloadToFile(asset.url, archive, (bytesDownloaded, bytesTotal) => {
    opts.onProgress?.({
      phase: "downloading-node",
      label: `Downloading Node.js ${PINNED_NODE_VERSION}`,
      bytesDownloaded,
      bytesTotal,
    });
  });

  opts.onProgress?.({ phase: "extracting-node", label: "Extracting Node.js runtime" });
  await fs.mkdir(getRuntimeRoot(), { recursive: true });

  const extractedTop =
    asset.format === "tar.gz"
      ? await extractTarGz(archive, getRuntimeRoot(), asset.topDir)
      : await extractZip(archive, getRuntimeRoot(), asset.topDir);

  const finalDir = getNodeInstallDir();
  if (extractedTop !== finalDir) {
    // Tarball top-dir embeds platform/arch; rename it to our canonical path.
    if (await pathExists(finalDir)) {
      await fs.rm(finalDir, { recursive: true, force: true });
    }
    await fs.rename(extractedTop, finalDir);
  }

  await fs.rm(tmpDir, { recursive: true, force: true });

  const binary = getNodeBinaryPath();
  if (!(await pathExists(binary))) {
    throw new Error(`Node install completed but binary not found at ${binary}`);
  }
  log.info(`[claude-code] Node installed at ${binary}`);
  return binary;
}

// ---------------------------------------------------------------------------
// Public: Node runtime
// ---------------------------------------------------------------------------

/**
 * Returns a path to a usable Node binary. Prefers the pinned bundled install;
 * falls back to system `node` if it satisfies engines.node >= 18 (currently
 * unused — we always install our own to keep behavior reproducible, but the
 * fallback is here for future flexibility).
 */
export async function ensureNodeRuntime(opts: EnsureOpts = {}): Promise<string> {
  const pinned = getNodeBinaryPath();
  if (await pathExists(pinned)) {
    return pinned;
  }
  return downloadAndInstallNode(opts);
}

// ---------------------------------------------------------------------------
// Claude Code install
// ---------------------------------------------------------------------------

async function readInstalledClaudeVersion(): Promise<string | null> {
  const pkgPath = path.join(
    getClaudeInstallDir(),
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "package.json",
  );
  try {
    const raw = await fs.readFile(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

function runNpmInstall(nodeBinary: string, installDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // We use `npm install <pkg>@<version>` rather than writing package.json
    // ourselves so npm handles peer deps, optional deps, and lockfile updates.
    const args = [
      getNpmCliPath(),
      "install",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      `@anthropic-ai/claude-code@${PINNED_CLAUDE_CODE_VERSION}`,
    ];
    log.info(`[claude-code] Running ${nodeBinary} ${args.join(" ")} in ${installDir}`);
    const child = spawn(nodeBinary, args, {
      cwd: installDir,
      env: {
        ...process.env,
        // Keep Corepack/yarn/pnpm out of our way and silence npm's update
        // notifier to avoid stray output.
        npm_config_update_notifier: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout?.on("data", (d) => log.debug(`[claude-code][npm] ${d.toString().trimEnd()}`));
    child.stderr?.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      log.warn(`[claude-code][npm] ${text.trimEnd()}`);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`npm install exited with code ${code}: ${stderr.trim() || "(no stderr)"}`));
      }
    });
  });
}

async function ensureInstallScaffold(installDir: string): Promise<void> {
  await fs.mkdir(installDir, { recursive: true });
  const pkgJsonPath = path.join(installDir, "package.json");
  if (!(await pathExists(pkgJsonPath))) {
    // Minimal package.json so npm doesn't try to walk up looking for one.
    await fs.writeFile(
      pkgJsonPath,
      JSON.stringify(
        {
          name: "hubcode-claude-host",
          private: true,
          version: "0.0.0",
          description: "Isolated install host for @anthropic-ai/claude-code used by the Hubcode agent.",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }
}

/**
 * Ensures the pinned @anthropic-ai/claude-code is installed at
 * ${userData}/claude/. Idempotent: skips work if the installed version
 * matches the pin. Uses the bundled Node from ensureNodeRuntime() as the
 * launcher for npm so we don't depend on system Node/npm being present.
 */
export async function ensureClaudeCode(opts: EnsureOpts = {}): Promise<ClaudeCodeStatus> {
  const installDir = getClaudeInstallDir();

  opts.onProgress?.({ phase: "checking", label: "Checking installed runtime" });
  const installedVersion = await readInstalledClaudeVersion();

  if (installedVersion === PINNED_CLAUDE_CODE_VERSION && (await pathExists(getClaudeBinaryPath()))) {
    opts.onProgress?.({ phase: "complete", label: "Hubcode runtime ready" });
    return {
      installed: true,
      pinnedVersion: PINNED_CLAUDE_CODE_VERSION,
      installedVersion,
      claudeBinary: getClaudeBinaryPath(),
      nodeBinary: getNodeBinaryPath(),
    };
  }

  try {
    const nodeBinary = await ensureNodeRuntime(opts);
    await ensureInstallScaffold(installDir);
    opts.onProgress?.({
      phase: "installing-claude-code",
      label: `Installing Claude Code ${PINNED_CLAUDE_CODE_VERSION}`,
    });
    await runNpmInstall(nodeBinary, installDir);
    await fs.mkdir(getClaudeHomeDir(), { recursive: true });

    const finalVersion = await readInstalledClaudeVersion();
    const finalBinary = getClaudeBinaryPath();
    const installedNow =
      finalVersion === PINNED_CLAUDE_CODE_VERSION && (await pathExists(finalBinary));
    if (!installedNow) {
      throw new Error(
        `Claude Code install reported success but resolved version=${finalVersion} ` +
          `binary exists=${await pathExists(finalBinary)}; expected ${PINNED_CLAUDE_CODE_VERSION} at ${finalBinary}.`,
      );
    }

    log.info(`[claude-code] Installed @anthropic-ai/claude-code@${finalVersion} at ${finalBinary}`);
    opts.onProgress?.({ phase: "complete", label: "Hubcode runtime ready" });
    return {
      installed: true,
      pinnedVersion: PINNED_CLAUDE_CODE_VERSION,
      installedVersion: finalVersion,
      claudeBinary: finalBinary,
      nodeBinary,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onProgress?.({ phase: "error", error: message });
    throw err;
  }
}

/**
 * Wipe the bundled Claude Code install (and its isolated CLAUDE_HOME) so the
 * next ensureClaudeCode() does a clean reinstall. Used by the "Reinstall"
 * affordance in Settings → Providers and as a recovery path when the install
 * gets corrupted (interrupted npm, manual fs tampering, etc.).
 *
 * We do NOT remove the bundled Node runtime — it's expensive to redownload
 * (~30 MB) and rarely the cause of a broken state. Bumping PINNED_NODE_VERSION
 * triggers its own re-extraction via ensureNodeRuntime().
 */
export async function wipeClaudeCode(): Promise<void> {
  await fs.rm(getClaudeInstallDir(), { recursive: true, force: true });
  log.info(`[claude-code] Wiped install at ${getClaudeInstallDir()}`);
}

/**
 * Read-only status for the renderer/UI. Does NOT trigger installs.
 */
export async function getClaudeCodeStatus(): Promise<ClaudeCodeStatus> {
  const installedVersion = await readInstalledClaudeVersion();
  const claudeBinary = getClaudeBinaryPath();
  const nodeBinary = getNodeBinaryPath();
  const installed =
    installedVersion === PINNED_CLAUDE_CODE_VERSION &&
    (await pathExists(claudeBinary)) &&
    (await pathExists(nodeBinary));
  return {
    installed,
    pinnedVersion: PINNED_CLAUDE_CODE_VERSION,
    installedVersion,
    claudeBinary,
    nodeBinary: (await pathExists(nodeBinary)) ? nodeBinary : null,
  };
}
