import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createServer, type Server } from "node:net";
import { writeFileSync, chmodSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SshHostConfig } from "./ssh-host-config.js";
import {
  ASKPASS_CANCELLED_MARKER,
  PROGRESS_MARKER,
  READY_MARKER,
  REMOTE_SHELL_COMMAND,
  describeEnsureFailure,
  describeSshFailure,
} from "./remote-daemon.js";

/** Keep the connection alive across NAT timeouts and detect a dead peer. */
const SERVER_ALIVE_INTERVAL_SECONDS = 15;
const SERVER_ALIVE_COUNT_MAX = 3;

/** Cap retained stderr so a chatty `npm install` cannot grow without bound. */
const MAX_STDERR_BYTES = 16_384;

/**
 * Base SSH arguments.
 *
 * `-p` is only passed when the port was set explicitly: passing it
 * unconditionally would override a `Port` directive the user configured for
 * this host in `~/.ssh/config`. Everything else in their SSH config
 * (`IdentityFile`, `ProxyJump`, `User`, ...) applies as usual.
 *
 * When `askpassPath` is set, BatchMode is dropped so SSH can prompt for a
 * password via the SSH_ASKPASS program. Without it, BatchMode makes auth fail
 * fast instead of hanging on a prompt the user cannot see.
 */
export function buildSshBaseArgs(
  config: SshHostConfig,
  options?: { askpassPath?: string; tty?: boolean },
): string[] {
  const args: string[] = [];
  if (config.port !== undefined) {
    args.push("-p", String(config.port));
  }
  args.push(
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
    "-o",
    `ServerAliveInterval=${SERVER_ALIVE_INTERVAL_SECONDS}`,
    "-o",
    `ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`,
  );
  if (!options?.askpassPath && !options?.tty) {
    args.push("-o", "BatchMode=yes");
  }
  // Note: SSH's default of 3 password attempts is left alone on purpose, so a
  // typo is retryable. A *cancelled* prompt is handled out of band — the
  // askpass program reports it via ASKPASS_CANCELLED_MARKER and the tunnel
  // tears the connection down at once, rather than being limited to one try.
  args.push(config.user ? `${config.user}@${config.host}` : config.host);
  return args;
}

/** Acquire a free ephemeral TCP port by briefly listening on :0. */
export function findFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface SshStderrReader {
  /** Everything SSH and the ensure script wrote, capped at a sane size. */
  text(): string;
}

/**
 * Watch the SSH process's stderr for the ensure script's structured markers
 * while also retaining the raw text.
 *
 * Retaining matters: attaching a `data` listener puts the stream in flowing
 * mode, so a later `stream.read()` returns nothing. Without buffering here,
 * every failure — bad password, missing Node, failed install — would surface
 * with an empty reason.
 */
function readSshStderr(
  child: ChildProcess,
  handlers: {
    onProgress?: (message: string) => void;
    onReady: () => void;
    onCancelled: () => void;
  },
): SshStderrReader {
  let retained = "";
  let pending = "";
  if (!child.stderr) {
    return { text: () => retained };
  }
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    retained = (retained + text).slice(-MAX_STDERR_BYTES);
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      // A PTY turns "\n" into "\r\n"; strip the remnant before matching.
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (clean.startsWith(READY_MARKER)) {
        handlers.onReady();
      } else if (clean.startsWith(ASKPASS_CANCELLED_MARKER)) {
        handlers.onCancelled();
      } else if (clean.startsWith(PROGRESS_MARKER)) {
        handlers.onProgress?.(clean.slice(PROGRESS_MARKER.length));
      }
    }
  });
  return { text: () => retained };
}

function buildTunnelEnv(askpassPath: string | undefined): NodeJS.ProcessEnv | undefined {
  if (!askpassPath) return undefined;
  return {
    ...process.env,
    SSH_ASKPASS: askpassPath,
    SSH_ASKPASS_REQUIRE: "force",
    // OpenSSH only consults SSH_ASKPASS when it believes a display exists.
    // SSH_ASKPASS_REQUIRE=force covers modern OpenSSH; DISPLAY covers the rest.
    DISPLAY: process.env.DISPLAY ?? ":0",
  };
}

/**
 * The user dismissed the password prompt. Distinct from an authentication
 * failure: nothing was wrong, they declined, so callers can say so plainly
 * instead of reporting a permission error.
 */
export class SshCancelledError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(`Connection to ${host} was cancelled.`);
    this.name = "SshCancelledError";
    this.host = host;
  }
}

/** Tunnels that must be reaped if the process exits without closing them. */
const liveTunnels = new Set<SshTunnel>();
let exitHookInstalled = false;

function trackTunnel(tunnel: SshTunnel): void {
  liveTunnels.add(tunnel);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const open of liveTunnels) open.close();
  });
}

export interface SshTunnelOptions {
  /**
   * Shell script piped to the remote `/bin/sh` over this connection's stdin.
   * On success it must fall through without exiting, so the remote shell keeps
   * blocking for input and the port forward outlives it (see
   * `buildEnsureScript`).
   */
  ensureScript: string;
  localPort?: number;
  readyTimeoutMs?: number;
  askpassPath?: string;
  /**
   * Aborts when the user declines a password prompt. SSH ignores the askpass
   * program's exit status and simply retries, so without this a dismissed
   * prompt would reappear until the attempts run out.
   */
  cancelSignal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Called if the tunnel dies on its own, i.e. not via {@link SshTunnel.close}. */
  onClose?: (reason: string) => void;
}

/**
 * An SSH local port-forward (`ssh -L`) kept open for the life of a tunneled
 * daemon connection.
 *
 * The ensure script runs inline on the same connection, so bringing up a
 * remote daemon costs one authentication rather than two. The port forward is
 * live from the moment SSH connects, but the daemon behind it may not be — so
 * readiness comes from the script's `READY:` marker, not from the local port
 * accepting connections, which would be a false positive.
 */
export class SshTunnel {
  private closedByUs = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly config: SshHostConfig,
    readonly localPort: number,
    readonly remotePort: number,
  ) {}

  static async open(
    config: SshHostConfig,
    remotePort: number,
    options: SshTunnelOptions,
  ): Promise<SshTunnel> {
    const localPort = options.localPort ?? (await findFreeLocalPort());
    const args = [
      "-L",
      `${localPort}:127.0.0.1:${remotePort}`,
      "-o",
      "ExitOnForwardFailure=yes",
      ...buildSshBaseArgs(config, { askpassPath: options.askpassPath }),
      REMOTE_SHELL_COMMAND,
    ];
    const spawnOpts: SpawnOptions = {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    };
    const env = buildTunnelEnv(options.askpassPath);
    if (env) spawnOpts.env = env;

    const child = spawn("ssh", args, spawnOpts);

    // The script goes to the remote `sh` over stdin, not as the remote command:
    // sshd would hand a command string to the user's own shell, which may not
    // be POSIX. Stdin is left open on purpose — `sh` blocking on the next line
    // is what holds the port forward up, and closing it is the teardown.
    child.stdin?.on("error", () => {
      // A failed auth closes the pipe before the script lands; the exit code
      // and stderr are the real diagnostics, so this is not worth surfacing.
    });
    child.stdin?.write(
      options.ensureScript.endsWith("\n") ? options.ensureScript : `${options.ensureScript}\n`,
    );

    let signalReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    // Set as soon as the askpass program reports a dismissed prompt, so the
    // failure that follows is reported as a cancellation rather than as an
    // authentication error.
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      // Don't wait for ssh to burn the remaining password attempts.
      child.kill("SIGTERM");
    };
    if (options.cancelSignal) {
      if (options.cancelSignal.aborted) cancel();
      else options.cancelSignal.addEventListener("abort", cancel, { once: true });
    }
    const stderr = readSshStderr(child, {
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      onReady: () => signalReady(),
      onCancelled: cancel,
    });

    const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once("close", (code) => resolve({ code }));
      child.once("error", (error) => resolve({ code: null, error }));
    });
    const timedOut = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), options.readyTimeoutMs ?? 300_000);
      timer.unref();
    });

    const outcome = await Promise.race([
      ready.then(() => "ready" as const),
      exited.then((result) => result),
      timedOut,
    ]);

    if (outcome !== "ready") {
      child.kill("SIGKILL");
      if (cancelled) {
        throw new SshCancelledError(config.host);
      }
      if (outcome === "timeout") {
        throw new Error(
          `Timed out waiting for the Paseo daemon on ${config.host}.${
            stderr.text().trim() ? `\n${stderr.text().trim()}` : ""
          }`,
        );
      }
      if (outcome.error) {
        throw new Error(`Failed to run ssh: ${outcome.error.message}`);
      }
      throw new Error(
        describeEnsureFailure({ config, exitCode: outcome.code, stderr: stderr.text() }),
      );
    }

    const tunnel = new SshTunnel(child, config, localPort, remotePort);
    trackTunnel(tunnel);
    // The forward is live but the SSH process can still die later — a dropped
    // network, a rebooted host, a killed remote shell. Tell the owner so it can
    // surface a disconnect instead of retrying against a port nothing serves.
    exited
      .then((result) => {
        liveTunnels.delete(tunnel);
        if (!tunnel.closedByUs) {
          options.onClose?.(
            result.error
              ? result.error.message
              : describeSshFailure(config.host, result.code, stderr.text()),
          );
        }
        return undefined;
      })
      .catch(() => undefined);
    return tunnel;
  }

  /** The host this tunnel forwards to, for diagnostics. */
  get host(): string {
    return this.config.host;
  }

  close(): void {
    this.closedByUs = true;
    liveTunnels.delete(this);
    if (!this.child.killed) {
      this.child.stdin?.destroy();
      this.child.kill("SIGKILL");
    }
  }
}

/** A temporary askpass script plus the private directory holding it. */
export interface AskpassScript {
  path: string;
  cleanup: () => void;
}

function writeAskpassScript(prefix: string, body: string): AskpassScript {
  // A private directory, not a predictable /tmp filename: on a shared host a
  // pid-named path in a world-writable directory is a symlink-attack target.
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const scriptPath = path.join(dir, "askpass.sh");
  writeFileSync(scriptPath, body, { mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  return {
    path: scriptPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    },
  };
}

/**
 * Create a temporary SSH_ASKPASS script that prompts on the terminal via
 * `/dev/tty`. Used by the CLI, where no GUI dialog is available.
 *
 * Echo is suppressed with `stty` rather than `read -s`: `-s` is a bash/zsh
 * extension, and `/bin/sh` is dash on Debian and Ubuntu, where it would fail
 * outright and hand SSH an empty password.
 */
export function createTerminalAskpassScript(): AskpassScript {
  const body = `#!/bin/sh
prompt=\${1:-Password:}
printf '%s ' "$prompt" >/dev/tty
saved=$(stty -g </dev/tty 2>/dev/null) || saved=""
[ -n "$saved" ] && stty -echo </dev/tty
if read -r password </dev/tty; then
  answered=1
else
  answered=0
fi
[ -n "$saved" ] && stty "$saved" </dev/tty
printf '\\n' >/dev/tty
if [ "$answered" = "1" ]; then
  printf '%s' "$password"
else
  # EOF (Ctrl-D) is this prompt's Cancel; say so rather than handing ssh an
  # empty password and getting asked again.
  echo "${ASKPASS_CANCELLED_MARKER}" >&2
  exit 1
fi
`;
  return writeAskpassScript("paseo-askpass-term-", body);
}
