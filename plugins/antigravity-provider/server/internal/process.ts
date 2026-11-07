import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { z } from "zod";
import { execCommand, spawnProcess } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { signalProcess } from "./signals.js";
import { AntigravityError, classifyFailure, jsonRpcErrorObjectSchema } from "./wire.js";

const PROBE_TIMEOUT_MS = 15_000;
const INIT_TIMEOUT_MS = 60_000;
const EXIT_WAIT_MS = 1_000;
const MAX_STDERR_CHARS = 8_192;

export function canonicalPath(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

interface PendingRpc {
  method: string;
  schema: z.ZodType<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: AntigravityError) => void;
  timer?: NodeJS.Timeout;
}

export interface DriverProcessHandlers {
  onNotification: (method: string, params: unknown) => void;
  onRequest: (id: string | number, method: string, params: unknown) => void;
  onExit: (error: AntigravityError) => void;
}

export class DriverProcess {
  readonly directories: ReadonlySet<string>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exitedPromise: Promise<void>;
  private readonly pending = new Map<string | number, PendingRpc>();
  private nextRpcId = 1;
  private stderr = "";
  private closing = false;
  private hasExited = false;
  private exitNotified = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    options: {
      launch: ProviderLaunch;
      cwd: string;
      additionalDirectories?: readonly string[];
    },
    private readonly handlers: DriverProcessHandlers,
  ) {
    const dirs = new Set<string>([canonicalPath(options.cwd)]);
    const args = [...options.launch.args, "acp", "--stdio", "--add-dir", options.cwd];
    for (const directory of options.additionalDirectories ?? []) {
      const resolved = canonicalPath(directory);
      if (!dirs.has(resolved)) {
        dirs.add(resolved);
        args.push("--add-dir", directory);
      }
    }
    this.directories = dirs;

    this.child = spawnProcess(options.launch.command, args, {
      cwd: options.cwd,
      env: { ...options.launch.env, NO_COLOR: "1" },
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    this.child.stdin.on("error", (error) => this.handleStdinFailure(error));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_CHARS);
    });

    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));

    this.exitedPromise = new Promise((resolve) => {
      this.child.once("error", (error) => {
        this.hasExited = true;
        lines.close();
        const failure = classifyFailure(this.stderr, error.message);
        this.failAllPending(failure);
        if (!this.closing) this.notifyExit(failure);
        resolve();
      });
      this.child.once("close", (code, signal) => {
        this.hasExited = true;
        lines.close();
        const exitReason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
        const failure = classifyFailure(this.stderr, `Antigravity ACP exited (${exitReason})`);
        this.failAllPending(failure);
        if (!this.closing) this.notifyExit(failure);
        resolve();
      });
    });
  }

  get isAlive(): boolean {
    return !this.hasExited && !this.closing;
  }

  hasDirectories(directories: Iterable<string>): boolean {
    for (const directory of directories) {
      if (!this.directories.has(canonicalPath(directory))) return false;
    }
    return true;
  }

  request<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.isAlive) {
      return Promise.reject(classifyFailure(this.stderr, "Antigravity ACP process is not running"));
    }
    const id = this.nextRpcId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              const msg = `Timed out waiting for Antigravity ACP response to ${method}`;
              reject(classifyFailure(this.stderr, msg));
            }, timeoutMs);
      this.pending.set(id, {
        method,
        schema,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  requestInit<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    return this.request(method, params, schema, INIT_TIMEOUT_MS);
  }

  notify(method: string, params: unknown): void {
    if (this.isAlive) this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  respond(id: string | number, result: unknown): void {
    if (this.isAlive) this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    if (this.isAlive) this.writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async interrupt(): Promise<void> {
    if (!this.hasExited) await this.signalGroup("SIGINT");
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.closing = true;
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  private async finishStop(): Promise<void> {
    if (process.platform === "win32") {
      // Node signal emulation kills only the leader; taskkill /T reaps any surviving tree.
      await this.signalGroup("SIGKILL");
      if (!this.hasExited) {
        await this.exitedPromise;
      }
      return;
    }

    if (!this.hasExited) {
      this.child.stdin.end();
      await this.signalGroup("SIGTERM");
      const killTimer = setTimeout(() => void this.signalGroup("SIGKILL"), EXIT_WAIT_MS);
      await this.exitedPromise;
      clearTimeout(killTimer);
    }

    // Reap any background or tool subprocess that outlived the ACP leader in the POSIX group.
    await this.signalGroup("SIGKILL");
  }

  private writeMessage(payload: Record<string, unknown>): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      this.handleStdinFailure(new Error("stdin is not writable"));
      return;
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (error) this.handleStdinFailure(error);
    });
  }

  private handleStdinFailure(error: Error): void {
    if (this.closing || this.hasExited) return;
    const failure = classifyFailure(this.stderr, `Antigravity ACP stdin failed: ${error.message}`);
    this.failAllPending(failure);
    this.notifyExit(failure);
    void this.stop();
  }

  private notifyExit(failure: AntigravityError): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    this.handlers.onExit(failure);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const message = parsed as Record<string, unknown>;
    const id =
      typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
    const method = typeof message.method === "string" ? message.method : undefined;

    if (id !== undefined && method === undefined) {
      this.handleResponse(id, message, trimmed);
      return;
    }
    if (id !== undefined && method !== undefined) {
      this.handlers.onRequest(id, method, message.params);
      return;
    }
    if (method !== undefined) {
      this.handlers.onNotification(method, message.params);
    }
  }

  private handleResponse(
    id: string | number,
    message: Record<string, unknown>,
    rawLine: string,
  ): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);

    if ("error" in message && message.error !== undefined) {
      const rpcError = jsonRpcErrorObjectSchema.safeParse(message.error);
      const detail = rpcError.success ? rpcError.data.message : "Antigravity ACP returned an error";
      entry.reject(classifyFailure(this.stderr, detail));
      return;
    }

    const validated = entry.schema.safeParse(message.result);
    if (!validated.success) {
      entry.reject(
        new AntigravityError(
          `Invalid Antigravity ACP response for ${entry.method}: ${validated.error.message}`,
          "WIRE_PARSE_ERROR",
          rawLine,
        ),
      );
      return;
    }
    entry.resolve(validated.data);
  }

  private failAllPending(error: AntigravityError): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private async signalGroup(signal: NodeJS.Signals): Promise<void> {
    if (this.child.pid) {
      await signalProcess({ platform: process.platform, pid: this.child.pid, signal });
    }
  }
}

export async function probe(options: {
  launch: ProviderLaunch;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<string> {
  try {
    const result = await execCommand(
      options.launch.command,
      [...options.launch.args, ...options.args],
      {
        cwd: options.cwd,
        env: { ...options.launch.env, NO_COLOR: "1" },
        shell: false,
        timeout: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      },
    );
    return result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const stderr =
      typeof error === "object" && error && "stderr" in error ? String(error.stderr) : "";
    throw classifyFailure(stderr, detail);
  }
}
