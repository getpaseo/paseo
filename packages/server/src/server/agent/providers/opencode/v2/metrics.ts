import type { SessionInfo, SessionMessageInfo, TokenUsageInfo } from "@opencode/client";
import type { AgentMetric } from "../../../agent-sdk-types.js";
import {
  formatMetricDuration,
  formatMetricRate,
  mergeTimeIntervals,
  type TimeInterval,
} from "../../metrics.js";
import { cacheMetric, costMetric, type MeasuredTokens, tokensMetric } from "../../turn-metrics.js";

type Step = Extract<SessionMessageInfo, { type: "assistant" }>;

/** Newer OpenCode servers stamp `firstToken`; steps recorded before it existed leave it unset. */
interface StepTime {
  readonly created: number;
  readonly firstToken?: number;
  /** When the response body ended, before tools settled. */
  readonly streamed?: number;
  readonly completed?: number;
}

/**
 * One prompt and the steps that answered it. Sessions with idle markers end a turn
 * at the marker, so a prompt steered into a running turn stays part of it; older
 * sessions end a turn at the next prompt.
 */
interface Turn {
  input: SessionMessageInfo | undefined;
  steps: Step[];
  /** The message whose replayed rows the turn's metrics follow. */
  lastMessageId: string | undefined;
  outcome: "succeeded" | "failed" | "interrupted" | undefined;
}

interface StepStats {
  /** Step wall time less the time its tools ran; null when any interval is unbelievable. */
  modelMs: number | null;
  toolMs: number | null;
  ttftMs: number | null;
}

function isInput(message: SessionMessageInfo) {
  return message.type === "user" || message.type === "synthetic";
}

function sessionTurns(messages: readonly SessionMessageInfo[]): Turn[] {
  const legacy = !messages.some((message) => message.type === "idle");
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const message of messages) {
    if (isInput(message) && (legacy || !current)) {
      current = { input: message, steps: [], lastMessageId: undefined, outcome: undefined };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (message.type === "assistant") {
      current.steps.push(message);
      current.lastMessageId = message.id;
    } else if (message.type === "idle") {
      current.outcome = message.outcome;
      current.lastMessageId = message.id;
      current = null;
    }
  }
  return turns;
}

function isCompleted(turn: Turn) {
  return turn.steps.length > 0 && turn.steps.every((step) => step.time.completed !== undefined);
}

function stepTime(step: Step): StepTime {
  return step.time;
}

function isWithin(value: number | undefined, start: number, end: number): value is number {
  return value !== undefined && Number.isFinite(value) && value >= start && value <= end;
}

function totalDuration(intervals: readonly TimeInterval[]) {
  return mergeTimeIntervals(intervals).reduce((sum, [start, end]) => sum + (end - start), 0);
}

function stepStats(step: Step): StepStats {
  const { created, firstToken, completed } = stepTime(step);
  if (
    completed === undefined ||
    !Number.isFinite(created) ||
    !isWithin(completed, created, completed)
  )
    return { modelMs: null, toolMs: null, ttftMs: null };
  const intervals: TimeInterval[] = [];
  let toolsValid = true;
  for (const part of step.content) {
    if (part.type !== "tool") continue;
    // A tool that failed while its input streamed never ran.
    if (part.state.status === "error" && part.time.ran === undefined) continue;
    const ran = part.time.ran;
    const ended = part.time.completed;
    if (
      (part.state.status !== "completed" && part.state.status !== "error") ||
      !isWithin(ran, created, completed) ||
      !isWithin(ended, ran, completed)
    ) {
      toolsValid = false;
      continue;
    }
    intervals.push([ran, ended]);
  }
  const toolMs = toolsValid ? totalDuration(intervals) : null;
  return {
    toolMs,
    modelMs: toolMs === null ? null : completed - created - toolMs,
    ttftMs:
      isWithin(firstToken, created, completed) && firstToken > created
        ? firstToken - created
        : null,
  };
}

/** Sums the values, or null when any is missing so a partial total is never shown. */
function sumAll(values: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return total;
}

function generated(tokens: TokenUsageInfo) {
  return tokens.output + tokens.reasoning;
}

function rate(tokens: number, ms: number) {
  return ms > 0 ? formatMetricRate(tokens / (ms / 1000)) : null;
}

/** The final reply's speed while it streamed, which a step that ran tools does not have. */
function responseRate(step: Step): string | null {
  if (step.error || !step.tokens || step.content.some((part) => part.type === "tool")) return null;
  const { created, firstToken, streamed, completed } = stepTime(step);
  if (completed === undefined || !isWithin(firstToken, created, completed)) return null;
  if (!isWithin(streamed, firstToken, completed)) return null;
  return rate(generated(step.tokens), streamed - firstToken);
}

function modelName(model: Step["model"]) {
  const name = `${model.providerID}/${model.id}`;
  return model.variant ? `${name} (${model.variant})` : name;
}

function durationMetric(label: string, ms: number | null): AgentMetric[] {
  const value = ms === null ? null : formatMetricDuration(ms);
  return value ? [{ label, value }] : [];
}

function measured(tokens: TokenUsageInfo): MeasuredTokens {
  return {
    input: tokens.input,
    output: generated(tokens),
    cacheRead: tokens.cache.read,
    cacheWrite: tokens.cache.write,
  };
}

function tokenMetrics(tokens: TokenUsageInfo, cacheLabel: string): AgentMetric[] {
  return [...tokensMetric(measured(tokens)), ...cacheMetric(measured(tokens), cacheLabel)];
}

function turnTokens(steps: readonly Step[]): TokenUsageInfo | null {
  const pick = (read: (tokens: TokenUsageInfo) => number) =>
    sumAll(steps.map((step) => (step.tokens ? read(step.tokens) : null)));
  const input = pick((tokens) => tokens.input);
  const output = pick((tokens) => tokens.output);
  const reasoning = pick((tokens) => tokens.reasoning);
  const read = pick((tokens) => tokens.cache.read);
  const write = pick((tokens) => tokens.cache.write);
  if (input === null || output === null || reasoning === null || read === null || write === null)
    return null;
  return { input, output, reasoning, cache: { read, write } };
}

function turnMetrics(turn: Turn): AgentMetric[] {
  const last = turn.steps.at(-1);
  if (!last || !isCompleted(turn)) return [];
  const stats = turn.steps.map(stepStats);
  const modelMs = sumAll(stats.map((step) => step.modelMs));
  const toolMs = sumAll(stats.map((step) => step.toolMs));
  const ttfts = stats.map((step) => step.ttftMs);
  const ttftTotal = sumAll(ttfts);
  const tokens = turnTokens(turn.steps);
  const ranTools = turn.steps.some((step) => step.content.some((part) => part.type === "tool"));
  const inputCreated = turn.input?.time.created;
  const lastCompleted = stepTime(last).completed;
  const elapsedMs =
    inputCreated !== undefined && lastCompleted !== undefined && lastCompleted >= inputCreated
      ? lastCompleted - inputCreated
      : null;
  const response = responseRate(last);
  const wholeTurn = tokens && modelMs !== null ? rate(generated(tokens), modelMs) : null;
  return [
    { label: "Model", value: modelName(last.model) },
    ...(response ? [{ label: "Response", value: response }] : []),
    ...(wholeTurn ? [{ label: "Whole turn", value: wholeTurn }] : []),
    ...durationMetric("Elapsed", elapsedMs),
    ...durationMetric("Model time", modelMs),
    ...(ranTools ? durationMetric("Tool time", toolMs) : []),
    ...durationMetric(
      turn.steps.length === 1 ? "TTFT" : "Average TTFT",
      ttftTotal === null ? null : ttftTotal / ttfts.length,
    ),
    ...(turn.steps.length > 1 ? [{ label: "Steps", value: String(turn.steps.length) }] : []),
    ...(tokens ? tokenMetrics(tokens, "Cache") : []),
    ...costMetric(sumAll(turn.steps.map((step) => step.cost))),
  ];
}

/** The metrics of the turn that just finished, read from the history after it settled. */
export function latestTurnMetrics(messages: readonly SessionMessageInfo[]): AgentMetric[] {
  const turn = sessionTurns(messages).at(-1);
  return turn ? turnMetrics(turn) : [];
}

/**
 * Each successful turn's metrics, keyed by the message they follow when the
 * history is replayed. Only successful turns: a live turn that failed or was
 * interrupted reports none either.
 */
export function replayedTurnMetrics(
  messages: readonly SessionMessageInfo[],
): Map<string, AgentMetric[]> {
  const legacy = !messages.some((message) => message.type === "idle");
  const replayed = new Map<string, AgentMetric[]>();
  for (const turn of sessionTurns(messages)) {
    if (!turn.lastMessageId || (!legacy && turn.outcome !== "succeeded")) continue;
    const metrics = turnMetrics(turn);
    if (metrics.length > 0) replayed.set(turn.lastMessageId, metrics);
  }
  return replayed;
}

/**
 * Session totals come from OpenCode's own cumulative counters: the loaded history
 * can be a compacted tail. The cache hit is the last reply's, since a session-wide
 * figure blends prompts from before and after compactions.
 */
export function sessionMetrics(
  info: Pick<SessionInfo, "tokens" | "cost">,
  messages: readonly SessionMessageInfo[],
): AgentMetric[] {
  const lastReply = messages.findLast(
    (message): message is Step =>
      message.type === "assistant" && message.time.completed !== undefined && !!message.tokens,
  );
  return [
    ...tokensMetric(measured(info.tokens)),
    ...(lastReply?.tokens ? cacheMetric(measured(lastReply.tokens), "Cache (last reply)") : []),
    ...costMetric(info.cost),
  ];
}
