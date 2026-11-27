import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentMetric } from "../../agent-sdk-types.js";
import { formatMetricDuration } from "../metrics.js";
import { cacheMetric, costMetric, type MeasuredTokens, tokensMetric } from "../turn-metrics.js";

/**
 * Turn and session metrics from Claude Code's result message, which ends every turn.
 * Transcripts do not record results, so replayed history has no turn metrics.
 */

function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function duration(label: string, ms: number | null): AgentMetric[] {
  const value = ms === null ? null : formatMetricDuration(ms);
  return value ? [{ label, value }] : [];
}

/** The main loop's tokens for the turn; subagents and side calls are not included. */
function turnTokens(result: SDKResultMessage): MeasuredTokens | null {
  const usage = result.usage;
  const input = amount(usage?.input_tokens);
  const output = amount(usage?.output_tokens);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cacheRead: amount(usage.cache_read_input_tokens) ?? 0,
    cacheWrite: amount(usage.cache_creation_input_tokens) ?? 0,
  };
}

/** Every model the session called, subagents included, since the SDK started counting. */
function sessionTokens(result: SDKResultMessage): { input: number; output: number } | null {
  let input = 0;
  let output = 0;
  for (const usage of Object.values(result.modelUsage ?? {})) {
    const modelInput = amount(usage?.inputTokens);
    const modelOutput = amount(usage?.outputTokens);
    if (modelInput === null || modelOutput === null) return null;
    input += modelInput;
    output += modelOutput;
  }
  return { input, output };
}

export interface ClaudeResultMetrics {
  turn: AgentMetric[];
  /** Null for a result whose totals are not the session's: Claude zeroes them on a crash. */
  session: AgentMetric[] | null;
}

/**
 * Reads results in the order one query() reports them. The SDK reports cost as a
 * running total for the query, so a turn's cost is the change since the last result.
 */
export class ClaudeResultMeter {
  private totalCostUsd: number | null = null;

  /** A new query() may start its running total from a saved one, so no change is known yet. */
  queryStarted(): void {
    this.totalCostUsd = null;
  }

  observe(result: SDKResultMessage, model: string | null): ClaudeResultMetrics {
    const total = amount(result.total_cost_usd);
    const previous = this.totalCostUsd;
    // A crashed run reports zero; keep counting from the last real total.
    if (total !== null && total > 0) this.totalCostUsd = total;
    const turnCost =
      total !== null && previous !== null && total >= previous ? total - previous : null;
    const tokens = turnTokens(result);
    const steps = amount(result.num_turns);
    const turn = [
      ...(model ? [{ label: "Model", value: model }] : []),
      ...duration("Elapsed", amount(result.duration_ms)),
      ...duration("Model time", amount(result.duration_api_ms)),
      ...duration("TTFT", "ttft_ms" in result ? amount(result.ttft_ms) : null),
      ...(steps !== null && steps > 1 ? [{ label: "Steps", value: String(steps) }] : []),
      ...(tokens ? [...tokensMetric(tokens), ...cacheMetric(tokens, "Cache")] : []),
      ...costMetric(turnCost),
    ];
    if (result.subtype !== "success") return { turn, session: null };
    const totals = sessionTokens(result);
    return {
      turn,
      session: [
        ...(totals ? tokensMetric(totals) : []),
        ...(tokens ? cacheMetric(tokens, "Cache (last turn)") : []),
        ...costMetric(total),
      ],
    };
  }
}
