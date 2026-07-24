import type { SshHostConfig } from "./ssh-host-config.js";
import { sshExec, type SshExecResult } from "./ssh-process.js";

/**
 * Detect whether an sshExec failure is an SSH connection/auth error rather
 * than a genuine command failure. SSH exits 255 for auth, connection refused,
 * host key, and DNS failures — all of which should surface the SSH error, not
 * a misleading "node not found" message.
 */
function isSshConnectionFailure(result: SshExecResult): boolean {
  if (result.exitCode !== 255) return false;
  const stderr = result.stderr.toLowerCase();
  return (
    stderr.includes("permission denied") ||
    stderr.includes("connection refused") ||
    stderr.includes("connection timed out") ||
    stderr.includes("could not resolve hostname") ||
    stderr.includes("host key verification failed") ||
    stderr.includes("operation timed out") ||
    stderr.includes("no route to host") ||
    stderr.includes("network is unreachable")
  );
}

function describeSshFailure(result: SshExecResult, host: string): string {
  const stderr = result.stderr.trim();
  if (stderr) return `SSH connection to ${host} failed: ${stderr}`;
  return `SSH connection to ${host} failed (exit code ${result.exitCode}).`;
}

/** Throw a descriptive error if the sshExec result is an SSH connection/auth failure. */
function assertNotSshFailure(result: SshExecResult, host: string): void {
  if (isSshConnectionFailure(result)) {
    throw new Error(describeSshFailure(result, host));
  }
}

/**
 * Expand a leading `~` to `$HOME` for use inside a remote command. The remote
 * shell expands `$HOME` (even inside double quotes) but not `~` (inside quotes),
 * so remote commands use `$HOME`-spelled paths.
 */
export function remoteExpandHome(p: string): string {
  if (p === "~") return "$HOME";
  if (p.startsWith("~/")) return `$HOME/${p.slice(2)}`;
  return p;
}

/** Remote PASEO_HOME, with `~` expanded to `$HOME`. */
export function remoteHomePath(config: SshHostConfig): string {
  return remoteExpandHome(config.remoteHome);
}

/** Remote Paseo install directory, with `~` expanded to `$HOME`. */
export function remoteInstallPath(config: SshHostConfig): string {
  return remoteExpandHome(config.installDir);
}

/** Path to the installed `paseo` binary on the remote host. */
export function remotePaseoBin(config: SshHostConfig): string {
  return `"${remoteInstallPath(config)}/node_modules/.bin/paseo"`;
}

/**
 * Build a single self-contained shell script that ensures a Paseo daemon is
 * running on the remote host. The script:
 *
 * 1. Checks if the daemon port is already listening (exit 0)
 * 2. Verifies node and npm are installed (exit 10 if not)
 * 3. Installs @getpaseo/cli if missing (exit 11 on install failure)
 * 4. Launches the daemon detached
 * 5. Waits for the port to accept connections (exit 12 on timeout)
 *
 * Progress markers are written to stderr as `PROGRESS:<message>` lines so the
 * caller can report status. The script runs in a single SSH call — one auth,
 * one connection, no multiplexing needed.
 *
 * Exit codes: 0 = ready, 10 = node missing, 11 = install failed,
 * 12 = not ready in time, 255 = SSH failure (from ssh itself).
 */
export function buildEnsureScript(config: SshHostConfig, version: string): string {
  const home = remoteHomePath(config);
  const installDir = remoteInstallPath(config);
  const bin = `"${installDir}/node_modules/.bin/paseo"`;
  const port = config.remotePort;
  const spec = version.trim() ? `@getpaseo/cli@${version}` : "@getpaseo/cli";
  const readyTimeoutMs = 30_000;
  const pollIntervalMs = 500;
  const maxPolls = Math.floor(readyTimeoutMs / pollIntervalMs);

  // A node one-liner that exits 0 if the port accepts a connection, 1 otherwise.
  const portCheck = `node -e 'const n=require("net");const s=n.connect({port:${port},host:"127.0.0.1"});s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>{s.destroy();process.exit(1)},3000)'`;

  return [
    `# 1. Already running?`,
    `${portCheck} && { echo "PROGRESS:Remote daemon is already running." >&2; exit 0; }`,
    `# 2. Check node and npm`,
    ``,
    `node -v >/dev/null 2>&1 && npm -v >/dev/null 2>&1 || { echo "PROGRESS:Node.js and npm are required on ${config.host}." >&2; exit 10; }`,
    ``,
    `# 3. Install Paseo if missing`,
    `if [ ! -x ${bin} ]; then`,
    `  echo "PROGRESS:Installing Paseo ${version} into ${config.installDir} on ${config.host}…" >&2`,
    `  mkdir -p "${installDir}"`,
    `  npm install --prefix "${installDir}" "${spec}" || { echo "PROGRESS:Failed to install Paseo on ${config.host}." >&2; exit 11; }`,
    `  echo "PROGRESS:Paseo installed on the remote host." >&2`,
    `else`,
    `  echo "PROGRESS:Paseo is already installed on the remote host." >&2`,
    `fi`,
    `# 4. Launch the daemon`,
    `echo "PROGRESS:Launching the Paseo daemon on ${config.host}…" >&2`,
    `mkdir -p "${home}"`,
    `${bin} daemon start --home "${home}" --port ${port} --no-relay --no-mcp`,
    ``,
    `# 5. Wait for the port to accept connections`,
    `echo "PROGRESS:Waiting for the remote daemon to become ready…" >&2`,
    `i=0`,
    `while [ $i -lt ${maxPolls} ]; do`,
    `  ${portCheck} && { echo "PROGRESS:Remote daemon is ready." >&2; exit 0; }`,
    `  sleep ${pollIntervalMs / 1000}`,
    `  i=$((i + 1))`,
    `done`,
    `echo "PROGRESS:The Paseo daemon was launched on ${config.host} but did not become ready on port ${port}. Check ${config.remoteHome}/daemon.log on the remote host." >&2`,
    `exit 12`,
  ].join("\n");
}

export interface EnsureRemoteDaemonOptions {
  config: SshHostConfig;
  /** @getpaseo/cli version to install if Paseo is missing. */
  version?: string;
  /** Progress callback for user-facing status messages. */
  onProgress?: (message: string) => void;
  /** Override the ssh exec implementation (for tests). */
  exec?: (command: string) => Promise<SshExecResult>;
  /** Per-command timeout in milliseconds (default 120s; install may be slow). */
  commandTimeoutMs?: number;
  /** Path to an SSH_ASKPASS program for interactive password prompts. */
  askpassPath?: string;
  /** SSH ControlMaster socket path for connection multiplexing. */
  controlPath?: string;
  /** Allocate a PTY for SSH (terminal password prompts). */
  tty?: boolean;
}

export interface EnsureRemoteDaemonResult {
  /** True if Paseo was installed during this call. */
  installed: boolean;
  /** True if the daemon was launched during this call. */
  launched: boolean;
  /** True if the remote daemon port is accepting connections. */
  ready: boolean;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

/**
 * Make sure a Paseo daemon is running on the remote host and accepting
 * connections on {@link SshHostConfig.remotePort}. Makes a single SSH call
 * with an inline script that checks, installs, launches, and waits — one auth,
 * one connection.
 */
export async function ensureRemoteDaemon(
  options: EnsureRemoteDaemonOptions,
): Promise<EnsureRemoteDaemonResult> {
  const { config, onProgress } = options;
  const version = options.version ?? config.packageVersion ?? "latest";
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const exec =
    options.exec ??
    ((command: string) =>
      sshExec(config, command, {
        timeoutMs: commandTimeoutMs,
        askpassPath: options.askpassPath,
        controlPath: options.controlPath,
        tty: options.tty,
      }));

  const progress = (message: string) => onProgress?.(message);

  progress(`Ensuring remote daemon on ${config.host}:${config.remotePort}…`);

  const script = buildEnsureScript(config, version);
  const result = await exec(script);

  // Parse PROGRESS: lines from stderr and forward them.
  for (const line of result.stderr.split("\n")) {
    const match = line.match(/^PROGRESS:(.*)$/);
    if (match) {
      progress(match[1]);
    }
  }

  if (result.exitCode === 0) {
    return { installed: false, launched: false, ready: true };
  }

  assertNotSshFailure(result, config.host);

  if (result.exitCode === 10) {
    throw new Error(
      `Node.js and npm are required on ${config.host} to run the Paseo daemon. ` +
        `Install Node.js (https://nodejs.org) on the remote host and retry.`,
    );
  }

  if (result.exitCode === 11) {
    throw new Error(
      `Failed to install Paseo on ${config.host}: ${result.stderr.trim() || result.stdout.trim() || "npm error"}`,
    );
  }

  if (result.exitCode === 12) {
    throw new Error(
      `The Paseo daemon was launched on ${config.host} but did not become ready ` +
        `on port ${config.remotePort} within 30s. ` +
        `Check ${config.remoteHome}/daemon.log on the remote host.`,
    );
  }

  throw new Error(
    `Failed to ensure remote daemon on ${config.host}: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`}`,
  );
}
