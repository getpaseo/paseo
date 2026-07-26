import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { once } from "node:events";
import { resolve, sep } from "node:path";
import type { ProcessEnvRecord } from "../paseo-env.js";
import { spawnProcess } from "../../utils/spawn.js";

/**
 * ProcessLaunchStrategy — the central abstraction that determines whether a
 * process spawns locally (default) or inside an isolated execution
 * environment (container, pod, VM, etc.) via the backend's exec mechanism.
 *
 * Resolved per workspace: a workspace with a running environment gets a
 * ContainerExecLaunchStrategy; all others get LocalLaunchStrategy.
 *
 * Two process categories route through this:
 *   1. Agent processes (ACP and direct providers)
 *   2. Terminal PTY processes (via wrapCommand + pty.spawn)
 *
 * Git commands deliberately do NOT route through this — see
 * docs/devcontainers.md ("Git runs on the host").
 */

export interface LaunchSpawnOptions {
  cwd?: string;
  /**
   * Base environment for the child. Local launches use it as the child's whole
   * environment; isolated launches forward only the entries that differ from
   * the daemon's own environment, because the image owns PATH/HOME/etc.
   */
  baseEnv?: ProcessEnvRecord;
  /** Alias for baseEnv, matching spawnProcess's option shape. */
  env?: ProcessEnvRecord;
  /** Explicit per-launch overrides. Always forwarded, isolated or not. */
  envOverlay?: ProcessEnvRecord;
  /** Host-spawn concern only; isolated launches take their base env from the image. */
  envMode?: "external" | "internal";
  shell?: boolean | string;
  stdio?: SpawnOptions["stdio"];
  detached?: boolean;
  signal?: AbortSignal;
}

/** The command and args to actually execute, possibly wrapped in an exec call. */
export interface ResolvedCommand {
  command: string;
  args: string[];
}

export interface WrapCommandOptions {
  cwd?: string;
  /**
   * Environment the wrapped command must observe. Isolated launches translate
   * this into exec env flags; local launches ignore it because the caller
   * applies the environment to its own spawn.
   */
  env?: ProcessEnvRecord;
  /** Allocate a TTY. Terminals need this; piped agent processes must not have it. */
  interactive?: boolean;
}

export interface ProcessLaunchStrategy {
  /**
   * Spawn a child process. For local execution, this is a direct spawn.
   * For container execution, this wraps the command in the backend's exec.
   */
  spawn(command: string, args: string[], options?: LaunchSpawnOptions): ChildProcess;

  /**
   * Resolve the command and args to execute, wrapping in the backend's exec
   * when inside a container. Used by callers that need to spawn via a different
   * mechanism (e.g. node-pty's pty.spawn for terminals).
   */
  wrapCommand(command: string, args: string[], options?: WrapCommandOptions): ResolvedCommand;

  /**
   * Map a host-side cwd to the execution context's cwd.
   * For local execution, returns the host path unchanged.
   * For container execution, returns the environment's workspace folder.
   */
  resolveCwd(hostCwd: string): string;

  /**
   * Rewrite a daemon-local URL (the agent MCP endpoint, the terminal activity
   * endpoint) into one the launched process can reach. Returns null when the
   * daemon is unreachable from the execution environment, so callers can drop
   * the feature instead of handing out an address that silently times out.
   */
  resolveDaemonUrl(url: string): string | null;

  /**
   * Find where the environment keeps this command, and return a path the
   * caller can spawn. An agent has to be installed inside the container —
   * whether that comes from the image or from a bind mount is the image's
   * business, not ours — but it does not have to sit on the bare exec's PATH,
   * because the lookup goes through the environment's own shell. Rejects with
   * a legible error rather than letting the launch fail as an opaque exit 127
   * from the container runtime.
   */
  resolveExecutable(command: string): Promise<string>;

  /**
   * The interactive shell a terminal should launch, or null when the caller's
   * own default applies. Local execution returns null. Container execution
   * returns the user's login shell inside the environment, because the host's
   * `$SHELL` (`/opt/homebrew/bin/fish`, say) usually isn't in the image.
   */
  resolveDefaultShell(): Promise<string | null>;

  /**
   * Serializable description of the execution environment, or null for local
   * execution. Strategy objects cannot cross a worker boundary; this can.
   */
  serialize(): ContainerExecSpec | null;

  readonly isIsolated: boolean;
}

/**
 * LocalLaunchStrategy — today's behavior. Spawns processes directly on the host.
 */
export class LocalLaunchStrategy implements ProcessLaunchStrategy {
  readonly isIsolated = false;

  spawn(command: string, args: string[], options?: LaunchSpawnOptions): ChildProcess {
    return spawnProcess(command, args, options);
  }

  wrapCommand(command: string, args: string[]): ResolvedCommand {
    return { command, args };
  }

  resolveCwd(hostCwd: string): string {
    return hostCwd;
  }

  resolveDaemonUrl(url: string): string {
    return url;
  }

  async resolveExecutable(command: string): Promise<string> {
    // The host already resolved this against its own PATH.
    return command;
  }

  async resolveDefaultShell(): Promise<null> {
    // The host terminal already knows its own default shell.
    return null;
  }

  serialize(): null {
    return null;
  }
}

/**
 * Serializable description of how to exec into a running environment.
 *
 * The final argv is assembled as:
 *   command, ...leadingArgs, ...optionArgs, <workdir/env/tty flags>, ...targetArgs, cmd, ...args
 *
 * Splitting options from the target this way keeps the assembly free of
 * positional guesswork: `docker exec` takes all its flags before the container
 * ID and treats everything after it as the command, while `kubectl exec` needs
 * a trailing `--` in targetArgs.
 */
export interface ContainerExecSpec {
  /** Binary that execs into the environment ("docker", "podman", "kubectl"). */
  command: string;
  /** Args before the option section (e.g. ["exec"]). */
  leadingArgs: string[];
  /** Options applied to every exec (e.g. ["-i", "-u", "node"]). */
  optionArgs: string[];
  /** The target and anything that must follow it (e.g. ["<id>"] or ["<pod>", "--"]). */
  targetArgs: string[];
  /** Flag that sets the working directory ("-w"), or null when unsupported. */
  workdirFlag: string | null;
  /** Flag that sets an environment variable ("-e"), or null when unsupported. */
  envFlag: string | null;
  /** Extra options for interactive (PTY) launches, e.g. ["-t"]. */
  ttyArgs: string[];
  /** Host-side workspace folder — the bind-mount source. */
  hostWorkspaceFolder: string;
  /** Workspace folder path inside the environment. */
  remoteWorkspaceFolder: string;
  /**
   * Address that routes back to the host from inside the environment (the
   * container's default gateway). Absent when it could not be determined.
   */
  hostGatewayAddress?: string;
}

/**
 * Environment variables the host owns and the image defines for itself.
 * Forwarding these would break command resolution and file layout inside the
 * environment, so they are dropped from the inherited base environment.
 * Explicit overlays still win — those are deliberate per-launch choices.
 */
const HOST_OWNED_ENV_KEYS = new Set([
  "PATH",
  "Path",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "HOSTNAME",
]);

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Asks the environment which shell the user has: `$SHELL` when the image sets
 * one, otherwise the login shell from the user's passwd entry.
 */
const DEFAULT_SHELL_PROBE_SCRIPT =
  'printf %s "${SHELL:-$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)}"';
const DEFAULT_SHELL_PROBE_TIMEOUT_MS = 5_000;
const EXECUTABLE_PROBE_TIMEOUT_MS = 10_000;
/** Startup files print banners; this marks which line is the probe's answer. */
const EXECUTABLE_PROBE_MARKER = "paseo-exe:";
/** Every POSIX image has this, so it is the answer when the probe comes up empty. */
const POSIX_FALLBACK_SHELL = "/bin/sh";

/**
 * Reduce a launch's environment to the entries that must be carried into the
 * environment, as `[key, value]` pairs where an undefined value means "unset".
 *
 * The image already provides a full environment, so the daemon's ambient
 * variables are deliberately not forwarded: entries in the base environment
 * count only when the caller changed them relative to the daemon's own
 * `process.env` (an added API key, a deleted NODE_OPTIONS, PASEO_AGENT_ID).
 * Host environment variables reach the container the way the Dev Container
 * spec intends — `containerEnv`/`remoteEnv` in devcontainer.json, which can
 * pull from the host with `${localEnv:NAME}`.
 */
export function resolveContainerEnvEntries(
  options: Pick<LaunchSpawnOptions, "baseEnv" | "env" | "envOverlay">,
  daemonEnv: ProcessEnvRecord = process.env,
): Array<[string, string | undefined]> {
  const entries = new Map<string, string | undefined>();

  const baseEnv = options.env ?? options.baseEnv;
  if (baseEnv) {
    for (const [key, value] of Object.entries(baseEnv)) {
      if (HOST_OWNED_ENV_KEYS.has(key)) continue;
      if (daemonEnv[key] === value) continue;
      entries.set(key, value);
    }
    // A key the daemon has but the caller dropped is an intentional unset.
    for (const key of Object.keys(daemonEnv)) {
      if (HOST_OWNED_ENV_KEYS.has(key)) continue;
      if (!(key in baseEnv)) entries.set(key, undefined);
    }
  }

  for (const [key, value] of Object.entries(options.envOverlay ?? {})) {
    entries.set(key, value);
  }

  return [...entries];
}

/**
 * ContainerExecLaunchStrategy — routes process spawning into a running
 * isolated environment via a configurable exec command.
 *
 * This strategy is generic: the backend that created the environment supplies
 * a ContainerExecSpec, so this class has no knowledge of Docker, Podman,
 * Kubernetes, or any specific runtime.
 */
export class ContainerExecLaunchStrategy implements ProcessLaunchStrategy {
  readonly isIsolated = true;

  private readonly spec: ContainerExecSpec;
  private defaultShell: Promise<string> | null = null;
  /** One resolution per command, cached for the container's lifetime. */
  private readonly executables = new Map<string, Promise<string>>();

  constructor(spec: ContainerExecSpec) {
    this.spec = { ...spec, hostWorkspaceFolder: resolve(spec.hostWorkspaceFolder) };
  }

  spawn(command: string, args: string[], options?: LaunchSpawnOptions): ChildProcess {
    const resolved = this.buildExecCommand(command, args, {
      cwd: options?.cwd,
      envEntries: resolveContainerEnvEntries(options ?? {}),
      interactive: false,
    });

    // The exec binary itself runs on the host, so it needs the daemon's own
    // environment to be found and to reach the container runtime's socket.
    return spawn(resolved.command, resolved.args, {
      cwd: this.spec.hostWorkspaceFolder,
      env: { ...process.env },
      stdio: options?.stdio ?? ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(options?.detached === undefined ? {} : { detached: options.detached }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  wrapCommand(command: string, args: string[], options?: WrapCommandOptions): ResolvedCommand {
    return this.buildExecCommand(command, args, {
      cwd: options?.cwd,
      envEntries: Object.entries(options?.env ?? {}),
      interactive: options?.interactive ?? false,
    });
  }

  private buildExecCommand(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      envEntries: Array<[string, string | undefined]>;
      interactive: boolean;
    },
  ): ResolvedCommand {
    const execArgs = [...this.spec.leadingArgs, ...this.spec.optionArgs];

    if (options.interactive) {
      execArgs.push(...this.spec.ttyArgs);
    }

    if (this.spec.workdirFlag) {
      const containerCwd = options.cwd
        ? this.resolveCwd(options.cwd)
        : this.spec.remoteWorkspaceFolder;
      execArgs.push(this.spec.workdirFlag, containerCwd);
    }

    if (this.spec.envFlag) {
      for (const [key, value] of options.envEntries) {
        // `-e KEY` (no value) unsets the variable inside the environment;
        // `-e KEY=value` sets it.
        execArgs.push(this.spec.envFlag, value === undefined ? key : `${key}=${value}`);
      }
    }

    execArgs.push(...this.spec.targetArgs, command, ...args);
    return { command: this.spec.command, args: execArgs };
  }

  resolveCwd(cwd: string): string {
    const remoteFolder = this.spec.remoteWorkspaceFolder;
    // Already an in-environment path. Agents run inside the environment, so
    // the paths they hand back (an ACP terminal's cwd, for instance) are
    // environment paths — mapping must be idempotent for those. This is
    // checked before resolving because resolving is a host operation: on a
    // Windows daemon it would turn "/workspaces/app" into "D:\workspaces\app".
    if (cwd === remoteFolder || cwd.startsWith(`${remoteFolder}/`)) {
      return cwd;
    }
    const resolved = resolve(cwd);
    const hostFolder = this.spec.hostWorkspaceFolder;
    if (resolved === hostFolder) {
      return remoteFolder;
    }
    if (resolved.startsWith(hostFolder + sep)) {
      // The host's separator on the way in, the environment's on the way out —
      // a container path is POSIX whatever the daemon runs on.
      const relative = resolved
        .slice(hostFolder.length + 1)
        .split(sep)
        .join("/");
      return `${remoteFolder}/${relative}`;
    }
    // Only the workspace folder is mounted, so anything else has no counterpart
    // inside the environment. The workspace folder is the one directory
    // guaranteed to exist there.
    return remoteFolder;
  }

  resolveDaemonUrl(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
      // Already an address the environment can route to (a LAN IP or a name).
      return url;
    }
    // Loopback inside the environment is the environment itself.
    if (!this.spec.hostGatewayAddress) return null;
    parsed.hostname = this.spec.hostGatewayAddress;
    return parsed.toString();
  }

  async resolveExecutable(command: string): Promise<string> {
    const cached = this.executables.get(command);
    if (cached) return cached;
    const resolved = this.probeExecutable(command);
    this.executables.set(command, resolved);
    // Only a success is worth keeping. A container still finishing its start,
    // or a probe that hit its timeout, would otherwise report the command
    // missing for the rest of the container's life — and the user's only way
    // out would be to rebuild it.
    resolved.catch(() => {
      if (this.executables.get(command) === resolved) this.executables.delete(command);
    });
    return resolved;
  }

  /**
   * Ask the environment where this command is. Whether it is installed in the
   * image or mounted into it is the image's business; what matters is that the
   * answer comes from inside, and that it is a path rather than a yes.
   *
   * `docker exec` starts a bare process, so the only PATH it has is the one the
   * image declares — typically `/usr/local/bin:/usr/bin`. A shell adds to that
   * from `~/.profile` and `~/.bashrc`, which is where `~/.local/bin`,
   * nvm and most per-user installs live. So an agent the user can run in a
   * container terminal would fail to launch here, with an error saying it was
   * not on the PATH while the terminal beside it ran it fine.
   *
   * Asking the environment's own login shell closes that gap, and returning the
   * absolute path it prints closes it for the launch too: the spawn no longer
   * depends on the exec's PATH at all.
   */
  private async probeExecutable(command: string): Promise<string> {
    // An absolute path answers itself.
    if (command.startsWith("/")) {
      if (await this.runsSuccessfully(["-c", `test -x ${shellQuote(command)}`])) return command;
      throw executableNotFoundError(command);
    }

    const shell = await this.resolveDefaultShell();
    const script = `printf '${EXECUTABLE_PROBE_MARKER}%s\\n' "$(command -v ${shellQuote(command)} || true)"`;
    // Login *and* interactive: PATH lives in `~/.profile` for some users and
    // `~/.bashrc` for others, and only the two together cover both.
    for (const flags of [
      ["-lic", script],
      ["-ic", script],
      ["-c", script],
    ]) {
      const found = readProbedPath(await this.captureOutput(shell, flags));
      if (found) return found;
    }

    // A shell builtin or an alias has no path to print, but it does run.
    if (await this.runsSuccessfully(["-c", `command -v ${shellQuote(command)}`])) return command;
    throw executableNotFoundError(command);
  }

  private async captureOutput(shell: string, args: string[]): Promise<string> {
    try {
      const child = this.spawn(shell, args, {
        // Interactive shells read stdin; an ignored one is an immediate EOF
        // rather than a probe that waits out its timeout.
        stdio: ["ignore", "pipe", "ignore"],
        signal: AbortSignal.timeout(EXECUTABLE_PROBE_TIMEOUT_MS),
      });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      const [code] = (await once(child, "close")) as [number | null];
      return code === 0 ? stdout : "";
    } catch {
      return "";
    }
  }

  private async runsSuccessfully(args: string[]): Promise<boolean> {
    try {
      const child = this.spawn("sh", args, {
        stdio: ["ignore", "ignore", "ignore"],
        signal: AbortSignal.timeout(EXECUTABLE_PROBE_TIMEOUT_MS),
      });
      const [code] = (await once(child, "close")) as [number | null];
      return code === 0;
    } catch {
      return false;
    }
  }

  async resolveDefaultShell(): Promise<string> {
    // One probe per strategy, so opening several terminals in the same
    // container doesn't re-ask.
    this.defaultShell ??= this.probeDefaultShell();
    return this.defaultShell;
  }

  /**
   * Ask the environment for the user's shell: `$SHELL` as the image defines it,
   * falling back to the login shell in the user's passwd entry. Anything
   * unusable — no answer, a relative path, an exec that never lands — resolves
   * to `/bin/sh`, which every POSIX image has.
   */
  private async probeDefaultShell(): Promise<string> {
    try {
      const child = this.spawn("sh", ["-c", DEFAULT_SHELL_PROBE_SCRIPT], {
        stdio: ["ignore", "pipe", "ignore"],
        signal: AbortSignal.timeout(DEFAULT_SHELL_PROBE_TIMEOUT_MS),
      });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      // Rejects if the child errors first (exec not found, probe timed out).
      await once(child, "close");
      const probed = stdout.trim();
      return probed.startsWith("/") ? probed : POSIX_FALLBACK_SHELL;
    } catch {
      return POSIX_FALLBACK_SHELL;
    }
  }

  serialize(): ContainerExecSpec {
    return { ...this.spec };
  }
}

/** POSIX shell quoting for a probe argument, so paths with spaces survive. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The marked line of a probe's output, when it names an absolute path. A shell
 * that greets you, or one whose `command -v` answers with a builtin's name
 * rather than a path, reads as no answer here.
 */
function readProbedPath(output: string): string | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(EXECUTABLE_PROBE_MARKER)) continue;
    const value = trimmed.slice(EXECUTABLE_PROBE_MARKER.length).trim();
    if (value.startsWith("/")) return value;
  }
  return null;
}

function executableNotFoundError(command: string): Error {
  return new Error(
    `'${command}' is not on the container's PATH. Install it in the image, put it on PATH there, or run this workspace on the host.`,
  );
}

/** Rebuild a strategy from its serialized form (e.g. inside the terminal worker). */
export function deserializeLaunchStrategy(
  spec: ContainerExecSpec | null | undefined,
): ProcessLaunchStrategy {
  return spec ? new ContainerExecLaunchStrategy(spec) : new LocalLaunchStrategy();
}
