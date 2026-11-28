import { z } from "zod";
import type { AgentMetric } from "../../agent-sdk-types.js";
import {
  type MeasuredStep,
  ReplayedTurns,
  sessionTotalsMetrics,
  type TurnMessageReader,
} from "../turn-metrics.js";
import type { PiAgentMessage, PiSessionStats } from "./rpc-types.js";

// Fields Pi records on a message that only metrics read. Each one falls back on its
// own: a value of an unexpected shape should cost that metric, not the message.
const count = z.number().nonnegative().optional().catch(undefined);
const label = z.string().min(1).optional().catch(undefined);

const PiUsageSchema = z.object({
  input: z.number().nonnegative(),
  /** Reasoning included: Pi reports reasoning as a part of output. */
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  cost: z.object({ total: z.number().nonnegative() }).optional().catch(undefined),
});

const PiReplyMetricsSchema = z.object({
  model: label,
  /** The model the provider reports it served. */
  responseModel: label,
  thinkingLevel: label,
  usage: PiUsageSchema.optional().catch(undefined),
  /** When the request was sent. */
  timestamp: count,
  /** From `timestamp` to the end of the response. */
  durationMs: count,
  stopReason: label,
  errorMessage: z.string().nullable().optional().catch(undefined),
});

const PiTimedMessageSchema = z.object({ timestamp: count, durationMs: count });

const UNFINISHED_STOP_REASONS = new Set(["toolUse", "error", "aborted"]);

function modelName(reply: z.infer<typeof PiReplyMetricsSchema>): string | null {
  const model = reply.responseModel ?? reply.model;
  if (!model) return null;
  const level = reply.thinkingLevel;
  return level && level !== "off" ? `${model} (${level})` : model;
}

/** A reply as a step. Pi does not record time to first token; live turns time it. */
export function piReplyStep(
  message: PiAgentMessage,
  ttftMs: number | null = null,
): MeasuredStep | null {
  if (message.role !== "assistant") return null;
  const reply = PiReplyMetricsSchema.parse(message);
  const usage = reply.usage;
  return {
    model: modelName(reply),
    tokens: usage
      ? {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        }
      : null,
    costUsd: usage?.cost?.total ?? null,
    durationMs: reply.durationMs ?? null,
    ttftMs,
    endedAt:
      reply.timestamp !== undefined && reply.durationMs !== undefined
        ? reply.timestamp + reply.durationMs
        : null,
  };
}

function isFinalReply(message: PiAgentMessage): boolean {
  if (message.role !== "assistant" || message.errorMessage) return false;
  return !UNFINISHED_STOP_REASONS.has(message.stopReason ?? "");
}

const reader: TurnMessageReader<PiAgentMessage> = {
  prompt: (message) =>
    message.role === "user"
      ? { startedAt: PiTimedMessageSchema.parse(message).timestamp ?? null }
      : null,
  reply: (message) => {
    const step = piReplyStep(message);
    return step
      ? {
          step,
          final: isFinalReply(message),
          endedOnTools: message.role === "assistant" && message.stopReason === "toolUse",
        }
      : null;
  },
  // A tool result is stamped when the tool finished.
  toolRun: (message) => {
    if (message.role !== "toolResult") return undefined;
    const { timestamp, durationMs } = PiTimedMessageSchema.parse(message);
    if (timestamp === undefined || durationMs === undefined || durationMs > timestamp) return null;
    return [timestamp - durationMs, timestamp];
  },
};

export function piReplayedTurns(): ReplayedTurns<PiAgentMessage> {
  return new ReplayedTurns(reader);
}

export function piSessionMetrics(
  stats: PiSessionStats,
  lastReply: MeasuredStep | null,
): AgentMetric[] {
  const metrics = sessionTotalsMetrics(
    {
      input: stats.tokens?.input ?? 0,
      output: stats.tokens?.output ?? 0,
      costUsd: stats.cost ?? null,
    },
    lastReply,
  );
  if (stats.toolCalls) metrics.push({ label: "Tool calls", value: String(stats.toolCalls) });
  return metrics;
}

const CONTENT_START_EVENTS = new Set(["text_start", "thinking_start", "toolcall_start"]);

/**
 * Times a live reply's first token, on the adapter's clock: from when the request went out
 * (`turn_start`) to the reply's first content. A reply's `message_start` only arrives once
 * the response headers have, so it stands in for the request only when no `turn_start` came.
 */
export class PiFirstTokenTimer {
  private startedAt: number | null = null;
  private firstTokenAt: number | null = null;

  requestSent(now: number): void {
    this.startedAt = now;
    this.firstTokenAt = null;
  }

  replyStarted(now: number): void {
    if (this.startedAt === null) this.requestSent(now);
  }

  replyUpdated(event: { type: string; delta?: unknown }, now: number): void {
    if (this.startedAt === null || this.firstTokenAt !== null) return;
    const delta = typeof event.delta === "string" && event.delta.length > 0;
    if (CONTENT_START_EVENTS.has(event.type) || delta) this.firstTokenAt = now;
  }

  /** The reply's time to first token, once it ended; null when unseen. */
  replyEnded(): number | null {
    const ttft =
      this.startedAt !== null && this.firstTokenAt !== null
        ? this.firstTokenAt - this.startedAt
        : null;
    this.startedAt = null;
    this.firstTokenAt = null;
    return ttft;
  }
}
