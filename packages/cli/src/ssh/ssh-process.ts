import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SshHostConfig } from "./ssh-host-config.js";

/**
 * Base SSH arguments. When `askpassPath` is set, BatchMode is dropped so SSH
 * can prompt for a password via the SSH_ASKPASS program. Without it, BatchMode
 * ensures auth fails fast instead of hanging on a prompt the user can't see.
 * When `tty` is set, a PTY is allocated (`-tt`) for interactive password
 * prompts directly on the terminal.
 */
export function buildSshBaseArgs(
  config: SshHostConfig,
  options?: { askpassPath?: string; tty?: boolean },
): string[] {
  const args = [
    "-p",
    String(config.port),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
  ];
  if (!options?.askpassPath && !options?.tty) {
    args.push("-o", "BatchMode=yes");
  }
  args.push(config.user ? `${config.user}@${config.host}` : config.host);
  return args;
}

export interface SshExecOptions {
  /** Per-command timeout in milliseconds. */
  timeoutMs?: number;
  /** Path to an SSH_ASKPASS program. When set, BatchMode is dropped. */
  askpassPath?: string;
  /** Allocate a PTY for the SSH process (terminal password prompts). */
  tty?: boolean;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/**
 * Run a command on the remote host via `ssh`. The command string is passed as a
 * single argument and interpreted by the remote user's login shell, so `$HOME`
 * and `~` expand remotely. Resolves with the captured result (never throws on
 * non-zero exit — callers inspect {@link SshExecResult.exitCode}).
 */
export function sshExec(
  config: SshHostConfig,
  command: string,
  options?: SshExecOptions,
): Promise<SshExecResult> {
  return new Promise((resolve) => {
    const sshArgs = [
      ...buildSshBaseArgs(config, {
        askpassPath: options?.askpassPath,
        tty: options?.tty,
      }),
      ...(options?.tty ? ["-tt"] : []),
      command,
    ];
    const spawnOpts: SpawnOptions = {
      stdio: options?.tty ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    };
    const child = spawn("ssh", sshArgs, spawnOpts);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };

    const timer =
      options?.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeoutMs)
        : null;

    let errored: string | null = null;
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      errored = error.message;
    });
    child.once("close", (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      settle(() => {
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: errored ? `${stderr}${errored}` : stderr,
          exitCode: code,
          signal,
          timedOut,
        });
      });
    });
  });
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

/** Poll a local TCP port until it accepts a connection or times out. */
export function waitForLocalPort(
  port: number,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const intervalMs = options?.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket: Socket = createConnection({ port, host: "127.0.0.1" });
      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };
      socket.on("connect", () => {
        cleanup();
        resolve(true);
      });
      socket.on("error", () => {
        cleanup();
        if (Date.now() >= deadline) {
          resolve(false);
        } else {
          setTimeout(attempt, intervalMs);
        }
      });
    };
    attempt();
  });
}
function attachProgressParser(child: ChildProcess, onProgress?: (message: string) => void): void {
  if (!onProgress || !child.stderr) return;
  let stderrBuffer = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = line.match(/^PROGRESS:(.*)$/);
      if (match) onProgress(match[1]);
    }
  });
}

function buildTunnelSpawnOpts(options?: {
  askpassPath?: string;
  tty?: boolean;
  ensureScript?: string;
}): SpawnOptions {
  // When an ensure script is provided, always pipe stderr for progress parsing.
  // tty is only for password prompts, but with an ensure script we use askpass.
  const useTty = options?.tty && !options?.ensureScript;
  const spawnOpts: SpawnOptions = {
    stdio: useTty ? "inherit" : ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
  if (options?.askpassPath) {
    spawnOpts.env = {
      ...process.env,
      SSH_ASKPASS: options.askpassPath,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY ?? ":0",
    };
  }
  return spawnOpts;
}

/**
 * An SSH local port-forward (`ssh -L`) kept open for the life of a tunneled
 * daemon connection. The tunnel is unref'd so it does not keep the Node event
 * loop alive on its own; {@link close} kills it (also registered on process
 * exit) so no orphaned `ssh` processes are left behind.
 */
export class SshTunnel {
  private constructor(
    private readonly child: ChildProcess,
    readonly localPort: number,
    readonly remotePort: number,
  ) {
    // Don't unref — the SSH process should keep the event loop alive so
    // close() can kill it before the process exits.
  }
  /**
   * Open an SSH local port-forward to `127.0.0.1:<remotePort>`. Resolves once
   * the local port accepts connections.
   *
   * When `ensureScript` is provided, it is run on the remote host through the
   * same SSH connection (no separate ensure call, no ControlMaster needed).
   * The port forward is active from the moment SSH connects, so the script can
   * launch the daemon and the local port becomes ready as soon as the daemon
   * listens. After the script exits, `exec cat` keeps the connection alive by
   * blocking on stdin forever — closing the tunnel (or the SSH process) drops
   * the connection.
   */
  static async open(
    config: SshHostConfig,
    remotePort: number,
    options?: {
      localPort?: number;
      readyTimeoutMs?: number;
      askpassPath?: string;
      tty?: boolean;
      ensureScript?: string;
      onProgress?: (message: string) => void;
    },
  ): Promise<SshTunnel> {
    const localPort = options?.localPort ?? (await findFreeLocalPort());
    const sshBaseArgs = buildSshBaseArgs(config, {
      askpassPath: options?.askpassPath,
      tty: options?.tty,
    });
    const args = [
      "-L",
      `${localPort}:127.0.0.1:${remotePort}`,
      "-o",
      "ExitOnForwardFailure=yes",
      ...sshBaseArgs,
    ];
    // When running an ensure script, keep the connection alive after the script
    // exits with `exec sleep infinity` (blocks on SIGTERM). Without a script,
    // use -N (no remote command, just port forwarding).
    if (options?.ensureScript) {
      args.push(`${options.ensureScript}; [ $? -eq 0 ] && exec sleep infinity`);
    } else {
      args.push("-N");
    }
    const progressCallbacks: ((msg: string) => void)[] = [];
    if (options?.onProgress) progressCallbacks.push(options.onProgress);
    const child = spawn("ssh", args, buildTunnelSpawnOpts(options));
    attachProgressParser(child, (msg) => {
      for (const cb of progressCallbacks) cb(msg);
    });

    // When an ensure script is provided, wait for the "Remote daemon is ready"
    // or "already running" progress message — the local port forward accepts
    // connections before the remote daemon is actually listening, so
    // waitForLocalPort would give a false positive. Without a script, the port
    // forward is to an already-running daemon, so waitForLocalPort is reliable.
    let ready: Promise<boolean>;
    if (options?.ensureScript) {
      ready = Promise.race([
        new Promise<boolean>((resolve) => {
          progressCallbacks.push((msg: string) => {
            if (msg.includes("daemon is ready") || msg.includes("already running")) {
              resolve(true);
            }
          });
        }),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), options?.readyTimeoutMs ?? 300_000);
          timer.unref();
        }),
      ]);
    } else {
      ready = waitForLocalPort(localPort, {
        timeoutMs: options?.readyTimeoutMs ?? 300_000,
      });
    }

    // If ssh dies before the port opens, surface its stderr.
    const exited = new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
      child.once("error", () => resolve(null));
    });

    const race = await Promise.race([
      ready.then((ok) => ({ ok, code: null as number | null })),
      exited.then((code) => ({ ok: false, code })),
    ]);

    if (!race.ok) {
      const stderr = child.stderr?.read()?.toString("utf8") ?? "";
      child.kill("SIGKILL");
      if (race.code !== null) {
        throw new Error(
          `SSH tunnel exited (code ${race.code}) before the port forward opened.${stderr ? ` ${stderr.trim()}` : ""}`,
        );
      }
      throw new Error(
        `SSH tunnel did not become ready on local port ${localPort} within the timeout.${stderr ? ` ${stderr.trim()}` : ""}`,
      );
    }
    const tunnel = new SshTunnel(child, localPort, remotePort);
    process.once("exit", () => tunnel.close());
    return tunnel;
  }

  close(): void {
    if (!this.child.killed) {
      this.child.stdin?.destroy();
      this.child.kill("SIGKILL");
    }
  }
}
/**
 * Create a temporary SSH_ASKPASS script that shows a native OS password
 * dialog. SSH calls this program (with the prompt as argv[1]) when it needs
 * a password and no tty is available. The password goes to stdout and is
 * never stored. Returns the script path; call `cleanupAskpassScript` to
 * remove it.
 */
export function createAskpassScript(): string {
  const scriptPath = path.join(tmpdir(), `paseo-askpass-${process.pid}.sh`);
  // macOS uses osascript; Linux tries zenity then kdialog.
  const script = `#!/bin/sh
if [ "$(uname)" = "Darwin" ]; then
  osascript -e 'display dialog "$1" default answer "" with hidden answer' -e 'text returned of result' 2>/dev/null
else
  zenity --password --title="$1" 2>/dev/null || kdialog --password "$1" 2>/dev/null
fi
`;
  writeFileSync(scriptPath, script, { mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  return scriptPath;
}

/**
 * Create a temporary SSH_ASKPASS script that prompts on the terminal via
 * /dev/tty. Used by the CLI where no GUI dialog is available. SSH invokes
 * this program with the prompt as argv[1]; the password goes to stdout.
 */
export function createTerminalAskpassScript(): string {
  const scriptPath = path.join(tmpdir(), `paseo-askpass-term-${process.pid}.sh`);
  const script = `#!/bin/sh
printf "%s: " "$1" >/dev/tty 2>&1
read -rs password </dev/tty
printf "\\n" >/dev/tty
printf "%s" "$password"
`;
  writeFileSync(scriptPath, script, { mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  return scriptPath;
}

/** Remove the temporary askpass script. */
export function cleanupAskpassScript(scriptPath: string): void {
  try {
    unlinkSync(scriptPath);
  } catch {
    // Best-effort cleanup.
  }
}
