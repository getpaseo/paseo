import type { AgentMetric } from "../agent-sdk-types.js";
import {
  cacheHitTone,
  computeCacheHitPercent,
  formatMetricCost,
  formatMetricDuration,
  formatMetricRate,
  formatTokenPair,
  mergeTimeIntervals,
  type TimeInterval,
} from "./metrics.js";

/**
 * Turn metrics for providers that report each model request of a turn as its own
 * message with usage and timing, as Pi and OMP do. The provider maps its messages
 * to steps; this module decides what the turn shows.
 */

const MIN_SPEED_DURATION_MS = 100;

export interface MeasuredTokens {
  /** Uncached prompt tokens. */
  input: number;
  /** Generated tokens, reasoning included. */
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One model request. A null field is one the provider did not report. */
export interface MeasuredStep {
  model: string | null;
  tokens: MeasuredTokens | null;
  costUsd: number | null;
  /** From sending the request to the end of the response. */
  durationMs: number | null;
  ttftMs: number | null;
  /** Wall-clock time the response ended. */
  endedAt: number | null;
}

export interface MeasuredTurn {
  steps: MeasuredStep[];
  /** Wall-clock time the prompt was sent. */
  startedAt: number | null;
  endedAt: number | null;
  /** Wall time tools ran, overlapping runs counted once. */
  toolMs: number | null;
}

/** The sum, or null when any value is missing so a partial total is never shown. */
function sumAll(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return total;
}

function sumTokens(steps: readonly MeasuredStep[]): MeasuredTokens | null {
  const pick = (read: (tokens: MeasuredTokens) => number) =>
    sumAll(steps.map((step) => (step.tokens ? read(step.tokens) : null)));
  const input = pick((tokens) => tokens.input);
  const output = pick((tokens) => tokens.output);
  const cacheRead = pick((tokens) => tokens.cacheRead);
  const cacheWrite = pick((tokens) => tokens.cacheWrite);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;
  return { input, output, cacheRead, cacheWrite };
}

/** Wall time the runs cover, overlapping runs counted once. */
function totalDuration(runs: readonly TimeInterval[]): number {
  return mergeTimeIntervals(runs).reduce((sum, [start, end]) => sum + (end - start), 0);
}

function metric(label: string, value: string | null): AgentMetric[] {
  return value ? [{ label, value }] : [];
}

function duration(label: string, ms: number | null): AgentMetric[] {
  return metric(label, ms === null ? null : formatMetricDuration(ms));
}

function speed(tokens: MeasuredTokens | null, modelMs: number | null): string | null {
  if (!tokens || modelMs === null || modelMs < MIN_SPEED_DURATION_MS) return null;
  return formatMetricRate(tokens.output / (modelMs / 1000));
}

export function tokensMetric(tokens: { input: number; output: number }): AgentMetric[] {
  if (tokens.input + tokens.output <= 0) return [];
  return [{ label: "Tokens", value: formatTokenPair(tokens.input, tokens.output) }];
}

export function cacheMetric(tokens: MeasuredTokens, label: string): AgentMetric[] {
  const percent = computeCacheHitPercent({
    input: tokens.input,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
  });
  if (percent === null) return [];
  const tone = cacheHitTone(percent);
  return [{ label, value: `${percent}%`, ...(tone ? { tone } : {}) }];
}

export function costMetric(usd: number | null): AgentMetric[] {
  return metric("Cost", usd === null ? null : formatMetricCost(usd));
}

/**
 * Totals from the provider's own session counters, which survive compactions the
 * transcript does not. The cache hit is the last reply's: a session-wide figure
 * blends prompts from before and after compactions.
 */
export function sessionTotalsMetrics(
  totals: { input: number; output: number; costUsd: number | null },
  lastReply: MeasuredStep | null,
): AgentMetric[] {
  return [
    ...tokensMetric(totals),
    ...(lastReply?.tokens ? cacheMetric(lastReply.tokens, "Cache (last reply)") : []),
    ...costMetric(totals.costUsd),
  ];
}

export function measuredTurnMetrics(turn: MeasuredTurn): AgentMetric[] {
  const { steps } = turn;
  const last = steps.at(-1);
  if (!last) return [];
  const tokens = sumTokens(steps);
  const modelMs = sumAll(steps.map((step) => step.durationMs));
  const ttftTotal = sumAll(steps.map((step) => step.ttftMs));
  const elapsedMs =
    turn.startedAt !== null && turn.endedAt !== null && turn.endedAt >= turn.startedAt
      ? turn.endedAt - turn.startedAt
      : null;
  return [
    ...metric("Model", last.model),
    ...metric("Speed", speed(tokens, modelMs)),
    ...duration("Elapsed", elapsedMs),
    ...duration("Model time", modelMs),
    ...(turn.toolMs !== null && turn.toolMs > 0 ? duration("Tool time", turn.toolMs) : []),
    ...duration(
      steps.length === 1 ? "TTFT" : "Average TTFT",
      ttftTotal === null ? null : ttftTotal / steps.length,
    ),
    ...(steps.length > 1 ? [{ label: "Steps", value: String(steps.length) }] : []),
    ...(tokens ? [...tokensMetric(tokens), ...cacheMetric(tokens, "Cache")] : []),
    ...costMetric(sumAll(steps.map((step) => step.costUsd))),
  ];
}

/**
 * Measures a live turn: its replies, and when its tools ran, which providers do
 * not record. Times are wall-clock milliseconds the caller passes in; the turn runs
 * from begin() to finish().
 */
export class TurnMeter {
  private startedAt: number | null = null;
  private steps: MeasuredStep[] = [];
  private running = new Map<string, number>();
  private toolRuns: TimeInterval[] = [];

  begin(now: number): void {
    this.reset();
    this.startedAt = now;
  }

  reset(): void {
    this.startedAt = null;
    this.steps = [];
    this.running = new Map();
    this.toolRuns = [];
  }

  step(step: MeasuredStep, now: number): void {
    this.startedAt ??= now;
    this.steps.push(step);
  }

  toolStarted(id: string, now: number): void {
    this.startedAt ??= now;
    this.running.set(id, now);
  }

  toolEnded(id: string, now: number): void {
    const started = this.running.get(id);
    if (started === undefined) return;
    this.running.delete(id);
    this.toolRuns.push([started, now]);
  }

  finish(now: number): MeasuredTurn {
    const toolMs = this.toolRuns.length === 0 ? null : totalDuration(this.toolRuns);
    return {
      steps: [...this.steps],
      startedAt: this.startedAt,
      // The adapter's clock on both ends: a provider's timestamps can come from another clock.
      endedAt: now,
      toolMs,
    };
  }
}

/** How a provider's transcript messages read as turns. */
export interface TurnMessageReader<Message> {
  /** When the message is a prompt, the time it was sent; null when it is not a prompt. */
  prompt(message: Message): { startedAt: number | null } | null;
  /** When the message is a model reply, its step and whether the turn ended with it. */
  reply(message: Message): { step: MeasuredStep; final: boolean; endedOnTools?: boolean } | null;
  /**
   * When the tool behind a tool result ran: undefined for other messages, null when
   * unrecorded. Readers whose transcripts never record it leave this out.
   */
  toolRun?(message: Message): TimeInterval | null | undefined;
}

interface ReplayedTurn {
  startedAt: number | null;
  steps: MeasuredStep[];
  /** Null once any run is unrecorded, so a partial tool time is never shown. */
  toolRuns: TimeInterval[] | null;
  final: boolean;
  /** The last reply asked for tools, so the turn may have gone on or been cut off there. */
  endedOnTools: boolean;
  /**
   * A prompt followed a turn that ended on tools. The transcript cannot say whether that
   * prompt steered the turn (live, one turn spanning both) or began another after a stop
   * (live, only the later steps), so no total is claimed for it.
   */
  unclear: boolean;
}

/**
 * Replays a transcript as turns, each running from a prompt to the reply before
 * the next prompt. Only turns that finished report metrics: one that failed or was
 * stopped reports none live either.
 */
export class ReplayedTurns<Message> {
  private turn: ReplayedTurn | null = null;
  private latestReply: MeasuredStep | null = null;

  constructor(private readonly reader: TurnMessageReader<Message>) {}

  /** The most recent reply replayed, for session metrics that describe it. */
  get lastReply(): MeasuredStep | null {
    return this.latestReply;
  }

  /** Metrics of the turn this message closes; replay them before the message's own rows. */
  observe(message: Message): AgentMetric[] {
    const prompt = this.reader.prompt(message);
    if (prompt) {
      // Prompts queued behind one another, with no reply between, share the first one's doubt.
      const unclear =
        this.turn !== null &&
        (this.turn.endedOnTools || (this.turn.unclear && this.turn.steps.length === 0));
      const closed = this.end();
      this.turn = this.open(prompt.startedAt);
      this.turn.unclear = unclear;
      return closed;
    }
    const reply = this.reader.reply(message);
    if (reply) {
      this.turn ??= this.open(null);
      this.turn.steps.push(reply.step);
      this.turn.final = reply.final;
      this.turn.endedOnTools = reply.endedOnTools === true;
      this.latestReply = reply.step;
      return [];
    }
    const run = this.reader.toolRun?.(message);
    if (run !== undefined && this.turn?.toolRuns) {
      this.turn.toolRuns = run === null ? null : [...this.turn.toolRuns, run];
    }
    return [];
  }

  /** Metrics of the open turn, once the transcript ends. */
  end(): AgentMetric[] {
    const turn = this.turn;
    this.turn = null;
    if (!turn?.final || turn.unclear) return [];
    return measuredTurnMetrics({
      steps: turn.steps,
      startedAt: turn.startedAt,
      endedAt: turn.steps.at(-1)?.endedAt ?? null,
      toolMs: turn.toolRuns ? totalDuration(turn.toolRuns) : null,
    });
  }

  private open(startedAt: number | null): ReplayedTurn {
    return {
      startedAt,
      steps: [],
      toolRuns: this.reader.toolRun ? [] : null,
      final: false,
      endedOnTools: false,
      unclear: false,
    };
  }
}
