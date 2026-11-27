import { z } from "zod";
import type { AgentMetric } from "../../agent-sdk-types.js";
import {
  type MeasuredStep,
  ReplayedTurns,
  sessionTotalsMetrics,
  type TurnMessageReader,
} from "../turn-metrics.js";
import type { OmpAgentMessage, OmpSessionStats } from "./rpc-types.js";

// Fields OMP records on a message that only metrics read. Each one falls back on its
// own: transcripts are read without validation, and a value of an unexpected shape
// should cost that metric, not the message.
const count = z.number().nonnegative().optional().catch(undefined);
const label = z.string().min(1).optional().catch(undefined);

const OmpUsageSchema = z.object({
  input: z.number().nonnegative(),
  /** Reasoning included. */
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  cost: z.object({ total: z.number().nonnegative() }).optional().catch(undefined),
});

const OmpReplyMetricsSchema = z.object({
  model: label,
  /** The model a router or gateway actually served. */
  upstreamModel: label,
  usage: OmpUsageSchema.optional().catch(undefined),
  /** When the request was sent. */
  timestamp: count,
  duration: count,
  ttft: count,
  /** Local time OMP finished streaming the response. */
  completedAt: count,
  stopReason: label,
  errorMessage: z.string().nullable().optional().catch(undefined),
});

const OmpPromptMetricsSchema = z.object({ timestamp: count });

const UNFINISHED_STOP_REASONS = new Set(["toolUse", "error", "aborted"]);

export function ompReplyStep(message: OmpAgentMessage): MeasuredStep | null {
  if (message.role !== "assistant") return null;
  const reply = OmpReplyMetricsSchema.parse(message);
  const usage = reply.usage;
  const endedAt =
    reply.completedAt ??
    (reply.timestamp !== undefined && reply.duration !== undefined
      ? reply.timestamp + reply.duration
      : undefined);
  return {
    model: reply.upstreamModel ?? reply.model ?? null,
    tokens: usage
      ? {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        }
      : null,
    costUsd: usage?.cost?.total ?? null,
    durationMs: reply.duration ?? null,
    ttftMs: reply.ttft ?? null,
    endedAt: endedAt ?? null,
  };
}

function isFinalReply(message: OmpAgentMessage): boolean {
  if (message.role !== "assistant" || message.errorMessage) return false;
  return !UNFINISHED_STOP_REASONS.has(message.stopReason ?? "");
}

const reader: TurnMessageReader<OmpAgentMessage> = {
  prompt: (message) =>
    message.role === "user"
      ? { startedAt: OmpPromptMetricsSchema.parse(message).timestamp ?? null }
      : null,
  reply: (message) => {
    const step = ompReplyStep(message);
    return step
      ? {
          step,
          final: isFinalReply(message),
          endedOnTools: message.role === "assistant" && message.stopReason === "toolUse",
        }
      : null;
  },
};

/** Replays an OMP transcript's turns. OMP does not record how long tools ran. */
export function ompReplayedTurns(): ReplayedTurns<OmpAgentMessage> {
  return new ReplayedTurns(reader);
}

export function ompSessionMetrics(
  stats: OmpSessionStats,
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
  if (stats.premiumRequests)
    metrics.push({ label: "Premium requests", value: String(stats.premiumRequests) });
  return metrics;
}
