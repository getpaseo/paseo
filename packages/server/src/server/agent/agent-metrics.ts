import type { AgentMetric } from "./agent-sdk-types.js";

const MAX_METRICS = 32;
const MAX_TEXT_LENGTH = 256;
const TONES: ReadonlySet<unknown> = new Set(["default", "ok", "warning", "danger"]);

function isTone(value: unknown): value is NonNullable<AgentMetric["tone"]> {
  return TONES.has(value);
}

function sanitizeMetric(value: unknown): AgentMetric | null {
  if (typeof value !== "object" || value === null) return null;
  const { label, value: text, tone } = value as Record<string, unknown>;
  if (typeof label !== "string" || label.length === 0 || typeof text !== "string") return null;
  return {
    label: label.slice(0, MAX_TEXT_LENGTH),
    value: text.slice(0, MAX_TEXT_LENGTH),
    ...(isTone(tone) ? { tone } : {}),
  };
}

/**
 * The one place provider metrics are checked. Providers build them from SDK and
 * process output Paseo does not control, and one malformed row would make a
 * client reject the whole snapshot, turn event, or timeline page that carries it.
 */
export function sanitizeAgentMetrics(value: unknown): AgentMetric[] {
  if (!Array.isArray(value)) return [];
  const metrics: AgentMetric[] = [];
  for (const entry of value) {
    const metric = sanitizeMetric(entry);
    if (metric) metrics.push(metric);
    if (metrics.length === MAX_METRICS) break;
  }
  return metrics;
}

/** Every completed turn can say which model ran it, even for providers that report nothing. */
export function withModelMetric(
  metrics: AgentMetric[],
  model: string | null | undefined,
): AgentMetric[] {
  if (!model || metrics.some((metric) => metric.label.toLowerCase() === "model")) return metrics;
  return [{ label: "Model", value: model }, ...metrics];
}
