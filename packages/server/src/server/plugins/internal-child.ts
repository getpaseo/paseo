import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { PluginServerContribution } from "@getpaseo/plugin/server";
import { createPluginWorker, type PluginWorkerChannel } from "./plugin-process.js";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";

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
      for (const handler of this.workerMessages) handler(copy);
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
        this.stdout.end();
        this.stderr.end();
        this.emit("close", 0, null);
      });
  }
}
