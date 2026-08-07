import type { Logger } from "pino";
import { z } from "zod";

import { buildMetadataPrompt, type RepoRootResolver } from "../../utils/build-metadata-prompt.js";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineCursor } from "./agent-timeline-store-types.js";

const SUMMARY_SCHEMA = z.object({
  summary: z
    .string()
    .min(1)
    .max(180)
    .describe("One-line present-tense summary of the agent's current purpose and progress."),
});

const DEFAULT_MIN_TURNS_BETWEEN_GENERATIONS = 3;
const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_TRANSCRIPT_MESSAGES = 12;
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 3_000;

interface SummaryCadenceState {
  inFlight: boolean;
  lastAttemptAt: number;
  wakeTimer: ReturnType<typeof setTimeout> | null;
}

type SummaryAgentManager = Pick<
  AgentManager,
  "fetchTimeline" | "getAgent" | "listAgents" | "setAgentSummary" | "subscribe"
>;

interface SummaryTranscript {
  text: string;
  cursor: AgentTimelineCursor;
}

export interface AgentPurposeSummaryGenerationRequest<T> {
  cwd: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  agentTitle: string;
}

export interface AgentPurposeSummaryGeneration {
  generate<T>(request: AgentPurposeSummaryGenerationRequest<T>): Promise<T>;
}

export interface AgentPurposeSummaryOptions {
  agentManager: SummaryAgentManager;
  generation: AgentPurposeSummaryGeneration;
  workspaceGitService?: RepoRootResolver;
  logger: Logger;
  minTurnsBetweenGenerations?: number;
  minIntervalMs?: number;
  now?: () => number;
}

export class AgentPurposeSummaryService {
  private readonly agentManager: SummaryAgentManager;
  private readonly generation: AgentPurposeSummaryGeneration;
  private readonly workspaceGitService?: RepoRootResolver;
  private readonly logger: Logger;
  private readonly minTurnsBetweenGenerations: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly cadenceByAgentId = new Map<string, SummaryCadenceState>();
  private readonly scheduled = new Set<ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(options: AgentPurposeSummaryOptions) {
    this.agentManager = options.agentManager;
    this.generation = options.generation;
    this.workspaceGitService = options.workspaceGitService;
    this.logger = options.logger.child({
      module: "agent",
      component: "agent-purpose-summary",
    });
    this.minTurnsBetweenGenerations =
      options.minTurnsBetweenGenerations ?? DEFAULT_MIN_TURNS_BETWEEN_GENERATIONS;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.unsubscribe || this.disposed) {
      return;
    }
    for (const agent of this.agentManager.listAgents()) {
      if (agent.internal || !this.turnConditionMet(agent)) {
        continue;
      }
      // Restore the interval floor across restarts. An agent whose floor has
      // already elapsed waits for its next completed turn so a daemon boot
      // doesn't fire a burst of generations.
      const state = this.getCadenceState(agent);
      if (state.lastAttemptAt > 0) {
        const remainingMs = this.minIntervalMs - (this.now() - state.lastAttemptAt);
        if (remainingMs > 0) {
          this.scheduleWake(agent.id, state, remainingMs);
        }
      }
    }
    this.unsubscribe = this.agentManager.subscribe((event) => this.handleAgentEvent(event), {
      replayState: false,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.scheduled) {
      clearTimeout(timer);
    }
    this.scheduled.clear();
    for (const state of this.cadenceByAgentId.values()) {
      this.clearWakeTimer(state);
    }
  }

  private handleAgentEvent(event: AgentManagerEvent): void {
    if (this.disposed) {
      return;
    }
    if (event.type === "agent_state") {
      if (event.agent.lifecycle !== "closed") {
        this.maybeGenerate(event.agent.id);
      }
      return;
    }
    if (event.type === "agent_stream" && event.event.type === "turn_completed") {
      this.maybeGenerate(event.agentId);
    }
  }

  /**
   * Single entry point for the cadence: generate now, or arm a wake timer for the
   * moment the interval floor passes. Called on completed turns, from wake timers,
   * and after a generation settles.
   */
  private maybeGenerate(agentId: string): void {
    if (this.disposed) {
      return;
    }
    const agent = this.agentManager.getAgent(agentId);
    if (!agent || agent.internal) {
      return;
    }
    const state = this.getCadenceState(agent);

    if (this.shouldGenerate(agent, state)) {
      this.clearWakeTimer(state);
      state.inFlight = true;
      const turnsAtStart = agent.summaryTurnsSinceUpdate ?? 0;
      const timer = setTimeout(() => {
        this.scheduled.delete(timer);
        let attempted = false;
        void this.generateSummary(agentId, turnsAtStart)
          .then((outcome) => {
            // An empty transcript is not an attempted generation. Wait for a
            // future timeline event instead of spinning or consuming the
            // interval floor before there is anything to summarize.
            attempted = outcome === "attempted";
            return outcome;
          })
          .finally(() => {
            state.inFlight = false;
            // `generateSummary` marks the attempt before any awaited work, so
            // a failed non-empty generation gets the same delayed retry as a
            // successful or stale generation.
            if (attempted) {
              this.maybeGenerate(agentId);
            }
          });
      }, 0);
      this.scheduled.add(timer);
      return;
    }

    if (state.inFlight || state.wakeTimer || !this.turnConditionMet(agent)) {
      return;
    }
    const remainingMs = this.minIntervalMs - (this.now() - state.lastAttemptAt);
    if (remainingMs > 0) {
      this.scheduleWake(agentId, state, remainingMs);
    }
  }

  private getCadenceState(agent: ManagedAgent): SummaryCadenceState {
    const existing = this.cadenceByAgentId.get(agent.id);
    if (existing) {
      return existing;
    }
    const state: SummaryCadenceState = {
      inFlight: false,
      lastAttemptAt: agent.summaryUpdatedAt?.getTime() ?? 0,
      wakeTimer: null,
    };
    this.cadenceByAgentId.set(agent.id, state);
    return state;
  }

  private scheduleWake(agentId: string, state: SummaryCadenceState, delayMs: number): void {
    this.clearWakeTimer(state);
    const timer = setTimeout(() => {
      if (state.wakeTimer === timer) {
        state.wakeTimer = null;
      }
      this.maybeGenerate(agentId);
    }, delayMs);
    state.wakeTimer = timer;
  }

  private clearWakeTimer(state: SummaryCadenceState): void {
    if (state.wakeTimer) {
      clearTimeout(state.wakeTimer);
      state.wakeTimer = null;
    }
  }

  private turnConditionMet(agent: ManagedAgent): boolean {
    const count = agent.summaryTurnsSinceUpdate ?? 0;
    return agent.summary ? count >= this.minTurnsBetweenGenerations : count > 0;
  }

  private shouldGenerate(agent: ManagedAgent, state: SummaryCadenceState): boolean {
    if (state.inFlight || !this.turnConditionMet(agent)) {
      return false;
    }
    return state.lastAttemptAt === 0 || this.now() - state.lastAttemptAt >= this.minIntervalMs;
  }

  private async generateSummary(
    agentId: string,
    consumedTurns: number,
  ): Promise<"empty" | "attempted"> {
    if (this.disposed) {
      return "empty";
    }
    const agent = this.agentManager.getAgent(agentId);
    if (!agent || agent.internal) {
      return "empty";
    }

    const expectedPreviousSummary = agent.summary ?? null;
    const transcript = this.buildTranscript(agent);
    if (!transcript) {
      return "empty";
    }

    this.getCadenceState(agent).lastAttemptAt = this.now();

    try {
      const prompt = await buildMetadataPrompt({
        cwd: agent.cwd,
        workspaceGitService: this.workspaceGitService,
        contract: [
          "Update the one-line purpose summary for this coding agent.",
          "Describe what it is currently trying to accomplish and the most meaningful current progress.",
          "Return JSON only with a single field 'summary'.",
        ].join(" "),
        styles: [
          {
            configKey: "agentSummary",
            default:
              "Use one concrete present-tense sentence. Stay under 180 characters and avoid generic phrases such as “working on the task”.",
          },
        ],
        after: [
          `Previous summary: ${expectedPreviousSummary ?? "(none yet)"}`,
          "",
          "Conversation since the previous summary:",
          transcript.text,
        ].join("\n"),
      });

      const result = await this.generation.generate({
        cwd: agent.cwd,
        prompt,
        schema: SUMMARY_SCHEMA,
        schemaName: "AgentPurposeSummary",
        agentTitle: "Agent summary generator",
      });
      if (this.disposed) {
        return "attempted";
      }

      await this.agentManager.setAgentSummary(agentId, result.summary, {
        expectedPreviousSummary,
        summaryCursor: transcript.cursor,
        consumedTurns,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, agentId, cwd: agent.cwd },
        "Failed to generate agent purpose summary",
      );
    }
    return "attempted";
  }

  private buildTranscript(agent: ManagedAgent): SummaryTranscript | null {
    const snapshot = this.agentManager.fetchTimeline(agent.id, { limit: 0 });
    const rows = this.filterTimelineRowsSinceSummary(agent, snapshot);
    const items = rows.map((row) => row.item).filter(isSummaryConversationItem);

    const bounded = boundTranscriptItems(items);
    if (bounded.length === 0) {
      return null;
    }
    return {
      text: bounded
        .map((item) => `${item.type === "user_message" ? "User" : "Agent"}: ${clip(item.text)}`)
        .join("\n\n"),
      cursor: {
        epoch: snapshot.epoch,
        seq: snapshot.window.maxSeq,
      },
    };
  }

  private filterTimelineRowsSinceSummary(
    agent: ManagedAgent,
    snapshot: ReturnType<SummaryAgentManager["fetchTimeline"]>,
  ) {
    const previousCursor = agent.summaryCursor;
    const summaryUpdatedAt = agent.summaryUpdatedAt?.getTime() ?? null;
    return snapshot.rows.filter((row) => {
      if (previousCursor) {
        return previousCursor.epoch === snapshot.epoch ? row.seq > previousCursor.seq : true;
      }
      return summaryUpdatedAt === null || Date.parse(row.timestamp) > summaryUpdatedAt;
    });
  }
}

type SummaryConversationItem = Extract<
  AgentTimelineItem,
  { type: "user_message" | "assistant_message" }
>;

function isSummaryConversationItem(item: AgentTimelineItem): item is SummaryConversationItem {
  return item.type === "user_message" || item.type === "assistant_message";
}

function boundTranscriptItems(
  items: readonly SummaryConversationItem[],
): SummaryConversationItem[] {
  const bounded: SummaryConversationItem[] = [];
  let totalChars = 0;
  for (const item of items.slice(-MAX_TRANSCRIPT_MESSAGES).toReversed()) {
    const clippedLength = Math.min(item.text.length, MAX_MESSAGE_CHARS);
    if (bounded.length > 0 && totalChars + clippedLength > MAX_TRANSCRIPT_CHARS) {
      break;
    }
    bounded.push(item);
    totalChars += clippedLength;
  }
  return bounded.toReversed();
}

function clip(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_MESSAGE_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}
