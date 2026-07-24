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
 * When `controlPath` is set, SSH connection multiplexing (ControlMaster) is
 * enabled so multiple sshExec calls and the tunnel share a single TCP
 * connection — the user authenticates once, not once per command.
 */
export function buildSshBaseArgs(
  config: SshHostConfig,
  options?: { askpassPath?: string; controlPath?: string; tty?: boolean },
): string[] {
  const args = [
    "-p",
    String(config.port),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
  ];
  if (options?.controlPath) {
    args.push(
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${options.controlPath}`,
      "-o",
      "ControlPersist=300",
    );
  }
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
  /** SSH ControlMaster socket path for connection multiplexing. */
  controlPath?: string;
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
        controlPath: options?.controlPath,
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
    child.unref();
  }

  /**
   * `127.0.0.1:<remotePort>`. Resolves once the local port accepts connections.
   */
  static async open(
    config: SshHostConfig,
    remotePort: number,
    options?: {
      localPort?: number;
      readyTimeoutMs?: number;
      askpassPath?: string;
      controlPath?: string;
      tty?: boolean;
    },
  ): Promise<SshTunnel> {
    const localPort = options?.localPort ?? (await findFreeLocalPort());
    const sshBaseArgs = buildSshBaseArgs(config, {
      askpassPath: options?.askpassPath,
      controlPath: options?.controlPath,
      tty: options?.tty,
    });
    const args = [
      "-L",
      `${localPort}:127.0.0.1:${remotePort}`,
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      ...sshBaseArgs,
    ];
    const spawnOpts: SpawnOptions = {
      stdio: options?.tty ? "inherit" : ["ignore", "pipe", "pipe"],
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
    const child = spawn("ssh", args, spawnOpts);

    const ready = waitForLocalPort(localPort, {
      timeoutMs: options?.readyTimeoutMs ?? 15_000,
    });

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
      this.child.kill("SIGTERM");
      const child = this.child;
      const killTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2_000);
      killTimer.unref();
      this.child.once("close", () => clearTimeout(killTimer));
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

/** Remove the temporary askpass script. */
export function cleanupAskpassScript(scriptPath: string): void {
  try {
    unlinkSync(scriptPath);
  } catch {
    // Best-effort cleanup.
  }
}
