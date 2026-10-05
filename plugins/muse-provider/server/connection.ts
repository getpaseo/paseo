import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { MuseError, classifyExit } from "./errors.js";
import { frameSchema, initializedSchema, fingerprint } from "./wire.js";

export function commandId(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export interface Notification {
  method: string;
  params: unknown;
}

export class MspConnection {
  private readonly child;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly listeners = new Set<(notification: Notification) => void>();
  private readonly exitListeners = new Set<(error: MuseError) => void>();
  private sequence = 0;
  private stderr = "";
  private failure: MuseError | null = null;
  private closing = false;
  private readonly exited: Promise<void>;

  constructor(
    private readonly options: {
      launch: ProviderLaunch;
      cwd?: string;
      timeoutMs?: number;
      serveArgs?: string[];
    },
  ) {
    const { launch, cwd } = options;
    this.child = spawn(launch.command, [...launch.args, "serve", ...(options.serveArgs ?? [])], {
      env: launch.env,
      cwd,
      stdio: "pipe",
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8192);
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        this.receive(frameSchema.parse(JSON.parse(line)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.fail(new MuseError("invalidFrame", `Invalid MSP frame: ${message}`));
        this.child.kill();
      }
    });
    this.child.stdin.on("error", () => {
      /* Process exit owns the diagnostic and pending requests. */
    });
    this.child.on("error", (error) => this.fail(new MuseError("spawn", error.message)));
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        lines.close();
        this.fail(classifyExit(code, signal, this.stderr));
        resolve();
      });
    });
  }

  async initialize(): Promise<void> {
    const response = await this.request(
      "initialize",
      {
        clientInfo: { name: "paseo", version: "1" },
        capabilities: {
          experimentalApi: true,
          requestedCapabilities: ["sessionMcp", "sessionListStream"],
        },
      },
      initializedSchema,
    );
    if (response.schema.fingerprint !== fingerprint) {
      process.stderr.write(
        `Muse MSP fingerprint mismatch: expected ${fingerprint}, received ${response.schema.fingerprint}\n`,
      );
    }
    this.write({ jsonrpc: "2.0", method: "initialized", params: {} });
  }

  onNotification(listener: (notification: Notification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onExit(listener: (error: MuseError) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  async command<T, P extends object>(method: string, params: P, schema: z.ZodType<T>): Promise<T> {
    const id =
      "commandId" in params && typeof params.commandId === "string"
        ? params.commandId
        : commandId();
    const input = { ...params, commandId: id };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request(method, input, schema);
      } catch (error) {
        const retryable =
          error instanceof MuseError && ["overloaded", "backpressured"].includes(error.kind);
        if (!retryable || attempt === 2) throw error;
        await delay(100 * (attempt + 1));
      }
    }
  }
  async request<T>(method: string, params: object, schema: z.ZodType<T>): Promise<T> {
    if (this.failure) throw this.failure;
    if (this.closing) throw new MuseError("closed", "Muse host is closing");
    const id = ++this.sequence;
    const response = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MuseError("timeout", `Muse ${method} timed out`));
      }, this.options.timeoutMs ?? 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
    return schema.parse(response);
  }
  async close(): Promise<void> {
    if (this.closing) return this.exited;
    this.closing = true;
    this.child.stdin.end();
    const drained = await Promise.race([
      this.exited.then(() => true),
      delay(1000).then(() => false),
    ]);
    if (!drained) this.child.kill("SIGKILL");
    await this.exited;
  }
  private write(frame: object): void {
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }
  private receive(frame: z.infer<typeof frameSchema>): void {
    if (frame.method) {
      if (frame.id !== undefined) {
        if (["approval/request", "userInput/request"].includes(frame.method)) {
          this.write({ jsonrpc: "2.0", id: frame.id, result: {} });
        } else {
          this.write({
            jsonrpc: "2.0",
            id: frame.id,
            error: { code: -32601, message: "Unsupported server request" },
          });
        }
        return;
      }
      for (const listener of this.listeners)
        listener({ method: frame.method, params: frame.params });
      return;
    }
    if (frame.id === undefined) throw new MuseError("invalidFrame", "MSP response has no id");
    if (frame.id === null) {
      if (!frame.error) throw new MuseError("invalidFrame", "MSP result has a null id");
      this.fail(new MuseError(frame.error.data?.kind ?? "rpc", frame.error.message));
      this.child.kill();
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.error) {
      let kind = frame.error.data?.kind ?? "rpc";
      if (frame.error.code === -32020) kind = "sessionNotFound";
      pending.reject(new MuseError(kind, frame.error.message, undefined, frame.error.data?.reason));
    } else pending.resolve(frame.result);
  }
  private fail(error: MuseError): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing) for (const listener of this.exitListeners) listener(error);
  }
}
