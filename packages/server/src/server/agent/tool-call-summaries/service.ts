import type { Logger } from "pino";
import { readToolCallSummary } from "@getpaseo/protocol/tool-call-summary";
import type { ToolCallSummarySource, ToolCallSummaryTarget } from "./types.js";
import { summaryCall, type SummaryCall, type SummaryResponse } from "./prompt.js";

export class SummaryCancellationError extends Error {}
export interface SummaryGenerator {
  generate(
    agentId: string,
    calls: SummaryCall[],
    attempt: number,
    signal: AbortSignal,
  ): Promise<SummaryResponse>;
  invalidate(agentId: string): Promise<void>;
  dispose(): Promise<void>;
}
interface SummaryServiceOptions {
  getSource: (target: ToolCallSummaryTarget) => ToolCallSummarySource | null;
  apply: (target: ToolCallSummaryTarget, description: string, filePath?: string) => Promise<void>;
  generator: SummaryGenerator;
  logger: Logger;
}
interface PendingCall {
  target: ToolCallSummaryTarget;
  queuedAt: number;
  attempt: number;
}
interface Batch {
  pending: PendingCall[];
  calls: SummaryCall[];
}

export class ToolCallSummarizer {
  private readonly queues = new Map<string, Map<string, PendingCall>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastStarted = Number.NEGATIVE_INFINITY;
  private active: { agentId: string; controller: AbortController; keys: Set<string> } | null = null;
  private task: Promise<void> | null = null;
  private stopped = false;
  private paused = false;
  private readonly cleanup = new Set<Promise<void>>();

  constructor(private readonly options: SummaryServiceOptions) {}

  enqueue(target: ToolCallSummaryTarget): void {
    if (this.stopped || this.paused) return;
    if (this.active?.agentId === target.agentId && this.active.keys.has(target.key)) return;
    const source = this.options.getSource(target);
    if (!source || readToolCallSummary(source.item.metadata, target.phase)) return;
    const queue = this.queues.get(target.agentId) ?? new Map<string, PendingCall>();
    if (queue.has(target.key)) return;
    queue.set(target.key, { target, queuedAt: Date.now(), attempt: 0 });
    this.queues.set(target.agentId, queue);
    if (queue.size > 250) {
      const oldest = queue.keys().next().value;
      if (oldest !== undefined) queue.delete(oldest);
      this.options.logger.warn(
        { agentId: target.agentId, dropped: 1 },
        "Tool-call summary queue overflow",
      );
    }
    this.schedule();
  }

  invalidate(agentId: string): void {
    this.queues.delete(agentId);
    if (this.active?.agentId === agentId) this.active.controller.abort();
    const task = this.options.generator.invalidate(agentId).catch((error: unknown) => {
      this.pause(error);
    });
    this.cleanup.add(task);
    void task.finally(() => {
      this.cleanup.delete(task);
    });
  }

  private pause(error: unknown): void {
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queues.clear();
    this.options.logger.error(
      { err: error },
      "Tool-call summarization paused: helper cleanup did not settle",
    );
  }

  private schedule(): void {
    if (this.stopped || this.paused || this.task || this.timer || this.queues.size === 0) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        const task = this.runNext();
        this.task = task;
        void task
          .catch((error: unknown) => this.pause(error))
          .finally(() => {
            this.task = null;
            this.schedule();
          });
      },
      Math.max(0, this.lastStarted + 5000 - Date.now()),
    );
    this.timer.unref();
  }

  private takeBatch(agentId: string, queue: Map<string, PendingCall>): Batch {
    this.queues.delete(agentId);
    const batch: Batch = { pending: [], calls: [] };
    let chars = 2;
    for (const [key, pending] of queue) {
      const source = this.options.getSource(pending.target);
      if (!source || readToolCallSummary(source.item.metadata, pending.target.phase)) {
        queue.delete(key);
        continue;
      }
      const call = summaryCall(key, source, pending.target.phase);
      const size = JSON.stringify(call).length + 1;
      if (batch.calls.length === 10 || chars + size > 32000) break;
      // Retries select the next provider; keep them in their own batch.
      if (batch.pending.length > 0 && batch.pending[0].attempt !== pending.attempt) break;
      queue.delete(key);
      batch.pending.push(pending);
      batch.calls.push(call);
      chars += size;
    }
    if (queue.size > 0) this.queues.set(agentId, queue);
    return batch;
  }

  private async runNext(): Promise<void> {
    if (this.stopped || this.paused) return;
    const next = this.queues.entries().next().value;
    if (!next) return;
    const [agentId, queue] = next;
    const batch = this.takeBatch(agentId, queue);
    if (batch.calls.length === 0) return;
    const controller = new AbortController();
    this.active = { agentId, controller, keys: new Set(batch.calls.map((call) => call.id)) };
    this.lastStarted = Date.now();
    const timeout = setTimeout(() => {
      this.options.logger.warn(
        { agentId },
        "Tool-call summary timed out; waiting for helper cancellation",
      );
      controller.abort(new Error("Tool-call summary timed out"));
    }, 60000);
    timeout.unref();
    try {
      const response = await this.options.generator.generate(
        agentId,
        batch.calls,
        batch.pending[0].attempt,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const descriptions = new Map(response.descriptions.map((entry) => [entry.id, entry]));
      for (const pending of batch.pending) {
        const description = descriptions.get(pending.target.key);
        if (description && !controller.signal.aborted)
          await this.options.apply(pending.target, description.description, description.filePath);
      }
      this.options.logger.debug(
        {
          agentId,
          count: batch.calls.length,
          durationMs: Date.now() - this.lastStarted,
          queueAgeMs: this.lastStarted - batch.pending[0].queuedAt,
          pendingConversations: this.queues.size,
        },
        "Tool-call summaries generated",
      );
    } catch (error) {
      if (error instanceof SummaryCancellationError) {
        this.pause(error);
        return;
      }
      this.options.logger.warn(
        { agentId, count: batch.calls.length, attempt: batch.pending[0].attempt },
        "Tool-call summary generation failed",
      );
      const lifecycleCanceled =
        controller.signal.aborted &&
        !(
          controller.signal.reason instanceof Error &&
          controller.signal.reason.message === "Tool-call summary timed out"
        );
      if (!this.stopped && !lifecycleCanceled) this.retry(agentId, batch.pending);
    } finally {
      clearTimeout(timeout);
      this.active = null;
    }
  }

  private retry(agentId: string, pending: PendingCall[]): void {
    const queue = this.queues.get(agentId) ?? new Map<string, PendingCall>();
    for (const call of pending) {
      if (call.attempt === 0 && this.options.getSource(call.target) && queue.size < 250) {
        queue.set(call.target.key, { ...call, attempt: 1 });
      }
    }
    if (queue.size > 0) this.queues.set(agentId, queue);
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.queues.clear();
    this.active?.controller.abort();
    await this.task;
    await Promise.all(this.cleanup);
    await this.options.generator.dispose();
  }
}
