import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { z } from "zod";
import { execCommand, spawnProcess } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { signalProcess } from "./signals.js";
import { AntigravityError, classifyFailure, jsonRpcErrorObjectSchema } from "./wire.js";

const PROBE_TIMEOUT_MS = 15_000;
const INIT_TIMEOUT_MS = 30_000;
const EXIT_WAIT_MS = 800;
const MAX_STDERR_CHARS = 8_192;

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
  readonly skipPermissions: boolean;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exitedPromise: Promise<void>;
  private readonly pending = new Map<string | number, PendingRpc>();
  private nextRpcId = 1;
  private stderr = "";
  private closing = false;
  private hasExited = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    options: {
      launch: ProviderLaunch;
      cwd: string;
      additionalDirectories?: readonly string[];
      skipPermissions?: boolean;
    },
    private readonly handlers: DriverProcessHandlers,
  ) {
    this.skipPermissions = Boolean(options.skipPermissions);
    const args = [
      ...options.launch.args,
      "acp",
      "--stdio",
      ...(this.skipPermissions ? ["--dangerously-skip-permissions"] : []),
      "--add-dir",
      options.cwd,
    ];
    for (const directory of options.additionalDirectories ?? []) {
      if (directory !== options.cwd) args.push("--add-dir", directory);
    }
    this.child = spawnProcess(options.launch.command, args, {
      cwd: options.cwd,
      env: childEnv(options.launch.env),
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    this.child.stdin.on("error", () => {});
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
        this.failAllPending(classifyFailure(this.stderr, error.message));
        resolve();
      });
      this.child.once("close", (code, signal) => {
        this.hasExited = true;
        lines.close();
        const detail = `Antigravity ACP exited (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})`;
        const failure = classifyFailure(this.stderr, detail);
        this.failAllPending(failure);
        if (!this.closing) this.handlers.onExit(failure);
        resolve();
      });
    });
  }

  get isAlive(): boolean {
    return !this.hasExited && !this.closing;
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
        timeoutMs !== undefined
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                classifyFailure(
                  this.stderr,
                  `Timed out waiting for Antigravity ACP response to ${method}`,
                ),
              );
            }, timeoutMs)
          : undefined;
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
    if (!this.isAlive) return;
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  respond(id: string | number, result: unknown): void {
    if (!this.isAlive) return;
    this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    if (!this.isAlive) return;
    this.writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async interrupt(): Promise<void> {
    await this.signal("SIGINT");
  }

  async stop(): Promise<void> {
    this.closing = true;
    if (this.hasExited) return;
    this.stopPromise ??= this.terminateProcess();
    await this.stopPromise;
  }

  private async terminateProcess(): Promise<void> {
    if (process.platform === "win32") {
      await this.signal("SIGKILL", true);
      await this.exitedPromise;
      return;
    }
    await this.signal("SIGTERM", true);
    const timer = setTimeout(() => {
      void this.signal("SIGKILL", true);
    }, EXIT_WAIT_MS);
    await this.exitedPromise;
    clearTimeout(timer);
    // A tool can keep running after its CLI leader exits.
    await this.signal("SIGKILL", true);
  }

  private writeMessage(payload: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
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
      this.handleResponseMessage(id, message, trimmed);
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

  private handleResponseMessage(
    id: string | number,
    message: Record<string, unknown>,
    trimmed: string,
  ): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);

    if ("error" in message && message.error !== undefined) {
      const rpcError = jsonRpcErrorObjectSchema.safeParse(message.error);
      const detail = rpcError.success ? rpcError.data.message : "Antigravity ACP returned an error";
      const rpcCode = rpcError.success ? rpcError.data.code : undefined;
      entry.reject(classifyFailure(this.stderr, detail, rpcCode));
      return;
    }

    const validated = entry.schema.safeParse(message.result);
    if (!validated.success) {
      entry.reject(
        new AntigravityError(
          `Invalid Antigravity ACP response for ${entry.method}: ${validated.error.message}`,
          "WIRE_PARSE_ERROR",
          trimmed,
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

  private async signal(signal: NodeJS.Signals, allowExited = false): Promise<void> {
    if (!this.child.pid || (this.hasExited && !allowExited)) return;
    await signalProcess({ platform: process.platform, pid: this.child.pid, signal });
  }
}

export async function probe(options: {
  launch: ProviderLaunch;
  args: string[];
  cwd?: string;
}): Promise<string> {
  try {
    const result = await execCommand(
      options.launch.command,
      [...options.launch.args, ...options.args],
      {
        cwd: options.cwd,
        env: childEnv(options.launch.env),
        shell: false,
        timeout: PROBE_TIMEOUT_MS,
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

function childEnv(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return { ...overrides, NO_COLOR: "1" };
}
