import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import { PassThrough } from "node:stream";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { createPluginWorker, type PluginWorkerChannel } from "./plugin-process.js";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";

const outputContext = new AsyncLocalStorage<InternalPluginChild>();
const originalConsole = {
  log: console.log,
  info: console.info,
  debug: console.debug,
  warn: console.warn,
  error: console.error,
};
let activeChildren = 0;

function captureOutput(): void {
  if (activeChildren++ > 0) return;
  for (const method of Object.keys(originalConsole) as Array<keyof typeof originalConsole>) {
    console[method] = (...args: unknown[]) => {
      const child = outputContext.getStore();
      if (!child) return originalConsole[method](...args);
      const stream = method === "warn" || method === "error" ? child.stderr : child.stdout;
      stream.write(`${format(...args)}\n`);
    };
  }
}

function releaseOutput(): void {
  if (--activeChildren > 0) return;
  for (const method of Object.keys(originalConsole) as Array<keyof typeof originalConsole>) {
    console[method] = originalConsole[method];
  }
}

export class InternalPluginChild extends EventEmitter {
  connected = true;
  killed = false;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly worker: ReturnType<typeof createPluginWorker>;
  private readonly workerMessages = new Set<(message: PluginProcessRequest) => void>();
  private closing: Promise<void> | null = null;

  constructor(contribute: PluginServerContribution) {
    super();
    captureOutput();
    const channel: PluginWorkerChannel = {
      send: (message: PluginProcessMessage, callback?: () => void) => {
        const copy = structuredClone(message);
        queueMicrotask(() => {
          if (this.connected) this.emit("message", copy);
          callback?.();
        });
      },
      onMessage: (handler) => {
        this.workerMessages.add(handler);
        return () => this.workerMessages.delete(handler);
      },
      disconnect: () => this.disconnect(),
    };
    this.worker = createPluginWorker({ channel, contribute });
  }

  send(message: PluginProcessRequest, callback?: (error: Error | null) => void): boolean {
    if (!this.connected) {
      callback?.(new Error("Plugin child is disconnected"));
      return false;
    }
    const copy = structuredClone(message);
    queueMicrotask(() => {
      outputContext.run(this, () => {
        for (const handler of this.workerMessages) handler(copy);
      });
      callback?.(null);
    });
    return true;
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.disconnect();
    return true;
  }

  disconnect(): void {
    if (this.closing) return;
    this.closing = Promise.resolve()
      .then(() => this.worker.shutdown())
      .finally(() => {
        this.connected = false;
        releaseOutput();
        this.stdout.end();
        this.stderr.end();
        this.emit("close", 0, null);
      });
  }
}
