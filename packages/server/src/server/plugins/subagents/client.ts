import { randomUUID } from "node:crypto";
import type { PluginSubagentReporter, PluginServerContext } from "@getpaseo/plugin/server";
import {
  parseSubagentEvent,
  type PluginSubagentRequest,
  type PluginSubagentResponse,
} from "./protocol.js";

interface PendingRequest {
  reject(error: Error): void;
  resolve(): void;
  timer: ReturnType<typeof setTimeout>;
}

class SubagentTransportError extends Error {}

export class PluginSubagentClient {
  private readonly pending = new Map<string, PendingRequest>();
  private stopped = false;

  private readonly send: (request: PluginSubagentRequest) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(send: (request: PluginSubagentRequest) => Promise<void>, timeoutMs = 30_000) {
    this.send = send;
    this.timeoutMs = timeoutMs;
  }

  readonly open: PluginServerContext["subagents"]["open"] = async ({ parentAgentId }) => {
    if (this.stopped) throw new Error("Plugin subagent reporting is stopped");
    const reporterId = randomUUID();
    try {
      await this.request({
        type: "subagents.request",
        reporterId,
        requestId: randomUUID(),
        operation: { type: "open", parentAgentId },
      });
    } catch (error) {
      this.release(reporterId);
      throw error;
    }
    let closed = false;
    let sequence = 0;
    let queued = 0;
    let tail = Promise.resolve();
    let closing: Promise<void> | null = null;
    const reporter: PluginSubagentReporter = {
      report: async (input) => {
        if (closed || this.stopped) throw new Error("Subagent reporter is closed");
        if (queued >= 32) throw new Error("Subagent report queue limit reached");
        const event = parseSubagentEvent(input);
        queued += 1;
        const result = tail.then(async () => {
          if (closed || this.stopped) throw new Error("Subagent reporter is closed");
          sequence += 1;
          try {
            await this.request({
              type: "subagents.request",
              reporterId,
              requestId: randomUUID(),
              operation: { type: "report", sequence, event },
            });
          } catch (error) {
            if (error instanceof SubagentTransportError) {
              closed = true;
              this.release(reporterId);
            }
            throw error;
          }
          return;
        });
        tail = result.catch(() => undefined);
        try {
          await result;
        } finally {
          queued -= 1;
        }
      },
      close: () => {
        if (closing) return closing;
        closed = true;
        closing = tail.then(async () => {
          if (this.stopped) return;
          return this.request({
            type: "subagents.request",
            reporterId,
            requestId: randomUUID(),
            operation: { type: "close" },
          });
        });
        return closing;
      },
    };
    return reporter;
  };

  receive(response: PluginSubagentResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.error === null) pending.resolve();
    else pending.reject(new Error(response.error));
  }

  stop(): void {
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SubagentTransportError("Plugin subagent IPC is closed"));
    }
    this.pending.clear();
  }

  private release(reporterId: string): void {
    if (this.stopped) return;
    void this.send({
      type: "subagents.request",
      reporterId,
      requestId: randomUUID(),
      operation: { type: "close" },
    }).catch(() => undefined);
  }

  private request(request: PluginSubagentRequest): Promise<void> {
    if (this.stopped)
      return Promise.reject(new SubagentTransportError("Plugin subagent IPC is closed"));
    if (this.pending.size >= 128)
      return Promise.reject(new SubagentTransportError("Subagent IPC request limit reached"));
    return new Promise((resolve, reject) => {
      let retries = request.operation.type === "report" ? 1 : 0;
      const fail = (error: Error) => {
        const pending = this.pending.get(request.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(request.requestId);
        reject(error);
      };
      const transmit = () => {
        void this.send(request).catch((error) => fail(new SubagentTransportError(String(error))));
      };
      const timeout = () => {
        const pending = this.pending.get(request.requestId);
        if (!pending) return;
        if (retries > 0) {
          retries -= 1;
          pending.timer = setTimeout(timeout, this.timeoutMs);
          transmit();
          return;
        }
        fail(new SubagentTransportError("Subagent IPC request timed out"));
      };
      this.pending.set(request.requestId, {
        resolve,
        reject,
        timer: setTimeout(timeout, this.timeoutMs),
      });
      transmit();
    });
  }
}
