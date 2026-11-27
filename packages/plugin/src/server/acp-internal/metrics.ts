import type { Usage } from "@agentclientprotocol/sdk";
import type { ProviderMetric } from "../provider.js";

const CACHE_HIT_OK_PERCENT = 50;

export interface AcpTurnMetricsInput {
  modelLabel?: string;
  durationMs: number;
  usage?: Usage;
  costUsd?: number;
}

export interface AcpSessionMetricTotals {
  turns: number;
  activeDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  thoughtTokens: number;
  costUsd?: number;
}

export function createEmptySessionMetricTotals(): AcpSessionMetricTotals {
  return {
    turns: 0,
    activeDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    thoughtTokens: 0,
  };
}

export function recordTurnMetrics(
  totals: AcpSessionMetricTotals,
  durationMs: number,
  usage: Usage | undefined,
): void {
  totals.turns += 1;
  if (Number.isFinite(durationMs) && durationMs > 0) {
    totals.activeDurationMs += durationMs;
  }
  if (!usage) return;
  totals.inputTokens += safeCount(usage.inputTokens);
  totals.outputTokens += safeCount(usage.outputTokens);
  totals.cachedReadTokens += safeCount(usage.cachedReadTokens);
  totals.cachedWriteTokens += safeCount(usage.cachedWriteTokens);
  totals.thoughtTokens += safeCount(usage.thoughtTokens);
}

export function buildAcpTurnMetrics(input: AcpTurnMetricsInput): ProviderMetric[] {
  const metrics: ProviderMetric[] = [];
  if (input.modelLabel) {
    metrics.push({ label: "Model", value: input.modelLabel });
  }
  const elapsed = formatMetricDuration(input.durationMs);
  if (elapsed) {
    metrics.push({ label: "Elapsed", value: elapsed });
  }
  if (input.usage) {
    const inputCount = safeCount(input.usage.inputTokens);
    const cacheRead = safeCount(input.usage.cachedReadTokens);
    const cacheWrite = safeCount(input.usage.cachedWriteTokens);
    const outputCount = safeCount(input.usage.outputTokens);
    const promptTotal = inputCount + cacheRead + cacheWrite;
    if (promptTotal > 0 || outputCount > 0) {
      metrics.push({ label: "Tokens", value: formatTokenPair(promptTotal, outputCount) });
    }
    if (cacheRead > 0 || cacheWrite > 0) {
      const percent = computeCacheHitPercent(inputCount, cacheRead, cacheWrite);
      if (percent !== null) {
        metrics.push({
          label: "Cache",
          value: `${percent}%`,
          ...(percent >= CACHE_HIT_OK_PERCENT ? { tone: "ok" as const } : {}),
        });
      }
    }
    const thoughts = safeCount(input.usage.thoughtTokens);
    if (thoughts > 0) {
      metrics.push({ label: "Thinking", value: formatMetricTokens(thoughts) });
    }
  }
  const cost = input.costUsd !== undefined ? formatMetricCost(input.costUsd) : null;
  if (cost) {
    metrics.push({ label: "Cost", value: cost });
  }
  return metrics;
}

export function buildAcpSessionMetrics(totals: AcpSessionMetricTotals): ProviderMetric[] {
  const metrics: ProviderMetric[] = [];
  if (totals.turns > 0) {
    metrics.push({ label: "Turns", value: String(totals.turns) });
  }
  const active = formatMetricDuration(totals.activeDurationMs);
  if (active) {
    metrics.push({ label: "Active", value: active });
  }
  const promptTotal = totals.inputTokens + totals.cachedReadTokens + totals.cachedWriteTokens;
  if (promptTotal > 0 || totals.outputTokens > 0) {
    metrics.push({ label: "Tokens", value: formatTokenPair(promptTotal, totals.outputTokens) });
  }
  if (totals.cachedReadTokens > 0 || totals.cachedWriteTokens > 0) {
    const percent = computeCacheHitPercent(
      totals.inputTokens,
      totals.cachedReadTokens,
      totals.cachedWriteTokens,
    );
    if (percent !== null) {
      metrics.push({
        label: "Cache",
        value: `${percent}%`,
        ...(percent >= CACHE_HIT_OK_PERCENT ? { tone: "ok" as const } : {}),
      });
    }
  }
  if (totals.thoughtTokens > 0) {
    metrics.push({ label: "Thinking", value: formatMetricTokens(totals.thoughtTokens) });
  }
  const cost = totals.costUsd !== undefined ? formatMetricCost(totals.costUsd) : null;
  if (cost) {
    metrics.push({ label: "Cost", value: cost });
  }
  return metrics;
}

function safeCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function formatMetricDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 50) return "<0.1s";
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatMetricTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  const count = Math.round(tokens);
  if (count < 1000) return String(count);
  const tenthsOfThousands = Math.round(count / 100);
  if (tenthsOfThousands < 10_000) return `${(tenthsOfThousands / 10).toFixed(1)}K`;
  return `${(Math.round(count / 100_000) / 10).toFixed(1)}M`;
}

export function formatTokenPair(input: number, output: number): string {
  return `${formatMetricTokens(input)} ↑ · ${formatMetricTokens(output)} ↓`;
}

export function formatMetricCost(usd: number): string | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (usd < 0.0005) return "<$0.001";
  return usd < 0.9995 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

function computeCacheHitPercent(
  input: number,
  cacheRead: number,
  cacheWrite: number,
): number | null {
  const prompt = input + cacheRead + cacheWrite;
  return prompt > 0 ? Math.round((cacheRead / prompt) * 100) : null;
}
