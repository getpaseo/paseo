import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { constants } from "node:os";
import path from "node:path";
import * as pty from "node-pty";

import type {
  WorkspaceDriverSpawnInput,
  WorkspacePipeProcess,
  WorkspacePtyProcess,
  WorkspaceProcessExit,
} from "../drivers/index.js";

export async function spawnHostProcess(
  root: string,
  input: WorkspaceDriverSpawnInput,
): Promise<WorkspacePipeProcess> {
  const cwd = await resolveRuntimeCwd(root, input.cwd);
  const child = spawn(input.argv[0], input.argv.slice(1), {
    cwd,
    env: { ...input.env },
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<WorkspaceProcessExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal: signal as NodeJS.Signals | null });
    });
  });

  return {
    kind: "pipes",
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill(signal = "SIGTERM") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process can exit between the state check and the signal.
        }
      }
      child.kill(signal);
    },
  };
}

export async function spawnHostPty(
  root: string,
  input: WorkspaceDriverSpawnInput,
): Promise<WorkspacePtyProcess> {
  if (input.stdio.kind !== "pty") throw new Error("PTY spawn requires PTY stdio");
  const cwd = await resolveRuntimeCwd(root, input.cwd);
  const process = pty.spawn(input.argv[0], input.argv.slice(1), {
    cwd,
    env: { ...input.env },
    name: input.stdio.term ?? "xterm-256color",
    cols: input.stdio.cols,
    rows: input.stdio.rows,
  });
  const exited = new Promise<WorkspaceProcessExit>((resolve) => {
    process.onExit(({ exitCode, signal }) => {
      const signalNumber = signal ?? 0;
      resolve({
        code: signalNumber === 0 ? exitCode : null,
        signal: signalName(signalNumber),
      });
    });
  });
  const listeners = new Set<(data: string) => void>();
  let pendingData = "";
  process.onData((data) => {
    if (listeners.size === 0) {
      pendingData += data;
      return;
    }
    for (const listener of listeners) listener(data);
  });

  return {
    kind: "pty",
    onData(listener) {
      listeners.add(listener);
      if (pendingData) {
        const data = pendingData;
        pendingData = "";
        listener(data);
      }
      return () => listeners.delete(listener);
    },
    write(data) {
      process.write(data);
    },
    resize(cols, rows) {
      process.resize(cols, rows);
    },
    exited,
    kill(signal) {
      process.kill(signal);
    },
  };
}

function signalName(signal: number): NodeJS.Signals | null {
  if (signal === 0) return null;
  for (const [name, number] of Object.entries(constants.signals)) {
    if (number !== undefined && number === signal && isNodeSignal(name)) return name;
  }
  return null;
}

function isNodeSignal(value: string): value is NodeJS.Signals {
  return value in constants.signals;
}

export async function resolveRuntimeCwd(root: string, relativeCwd?: string): Promise<string> {
  const normalizedRoot = await realpath(root);
  const cwd = await realpath(path.resolve(normalizedRoot, relativeCwd ?? "."));
  const relative = path.relative(normalizedRoot, cwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Workspace cwd escapes its runtime root: ${relativeCwd}`);
  }
  return cwd;
}
