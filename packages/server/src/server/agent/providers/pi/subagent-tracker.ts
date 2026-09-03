import type { Logger } from "pino";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import {
  MAX_SUBAGENT_TIMELINE_ROWS,
  buildPiSubagentSubtitle,
  piSubagentDescriptorId,
  piSubagentStatusFromResult,
  piSubagentTimelineEvents,
  readPiSubagentInlineOutput,
  readPiSubagentLaunchArgs,
  readPiSubagentRunPayload,
  streamPiChildSessionItems,
  type PiSubagentResultEntry,
  type PiSubagentRunPayload,
} from "./subagent-run.js";

const PI_PROVIDER = "pi";
const DEFAULT_SUBAGENT_TITLE = "Pi subagent";

interface PiSubagentState {
  title: string;
  description: string | null;
  resolvedModel?: string;
  activity?: string;
  subtitle?: string;
  reportedStatus: PiSubagentStatus;
}

type PiSubagentStatus = "running" | "completed" | "failed" | "canceled";

/**
 * Tracks `pi-subagents` tool executions and translates them into provider
 * subagent stream events. The `subagent` tool is an extension tool, so Pi
 * reports its lifecycle through the generic tool_execution_* events with the
 * run payload in tool result `details` (see pi-subagents `Details`).
 *
 * Child transcripts are standard Pi session files referenced by
 * `details.results[].sessionFile`. On completion the tracker reads the child
 * file and replays it as subagent timeline rows so the app can render what the
 * child did without the parent transcript carrying it.
 */
export class PiSubagentTracker {
  private readonly states = new Map<string, PiSubagentState>();

  constructor(private readonly logger: Logger) {}

  /** tool_execution_start for a `subagent` call: open a running descriptor. */
  start(toolCallId: string, args: unknown): AgentStreamEvent[] {
    const input = readPiSubagentLaunchArgs(args);
    if (!input) {
      return [];
    }
    this.states.set(toolCallId, {
      title: input.agent ?? DEFAULT_SUBAGENT_TITLE,
      description: input.task ?? null,
      reportedStatus: "running",
    });
    return [this.upsert(toolCallId, "running")];
  }

  /** tool_execution_update: refresh the compact subtitle (activity, model). */
  update(toolCallId: string, partialResult: unknown): AgentStreamEvent[] {
    const state = this.states.get(toolCallId);
    if (!state) {
      return [];
    }
    const run = readPiSubagentRunPayload(partialResult);
    if (!run) {
      return [];
    }
    const first = run.results[0];
    const model = first?.model ?? first?.progress?.model;
    const activity = readText(first?.progress?.activityState);
    const subtitle = buildPiSubagentSubtitle(
      model ?? state.resolvedModel,
      activity ?? state.activity,
    );
    if (!subtitle || subtitle === state.subtitle) {
      return [];
    }
    if (model) {
      state.resolvedModel = model;
    }
    if (activity) {
      state.activity = activity;
    }
    state.subtitle = subtitle;
    return [this.upsert(toolCallId, "running")];
  }

  /**
   * tool_execution_end for a `subagent` call: replay child transcripts into
   * the subagent timeline and finalize the descriptor status.
   */
  async end(toolCallId: string, result: unknown, isError: boolean): Promise<AgentStreamEvent[]> {
    const state = this.states.get(toolCallId);
    if (!state) {
      return [];
    }
    this.states.delete(toolCallId);

    const run = readPiSubagentRunPayload(result);
    const descriptorId = piSubagentDescriptorId(toolCallId, run);
    const events: AgentStreamEvent[] = [];
    if (descriptorId !== toolCallId) {
      // The store keys descriptors by id and has no rename, so close the
      // tool-call-id descriptor opened at start and continue under the
      // pi-subagents run id.
      events.push({
        type: "provider_subagent",
        provider: PI_PROVIDER,
        event: { type: "remove", id: toolCallId },
      });
    }

    let rows = 0;
    for (const sessionFile of sessionFilesOf(run)) {
      try {
        for await (const { item } of streamPiChildSessionItems(sessionFile)) {
          if (rows >= MAX_SUBAGENT_TIMELINE_ROWS) {
            break;
          }
          rows += 1;
          events.push(...piSubagentTimelineEvents(descriptorId, [item]));
        }
      } catch (error) {
        this.logger.debug({ err: error, sessionFile }, "Failed to read Pi subagent child session");
      }
    }
    if (rows === 0) {
      // No child transcript on disk (launch failure, async run still going, or
      // details stripped). Surface the inline tool output as a single row so
      // the tab is never empty.
      const text = readPiSubagentInlineOutput(result);
      if (text) {
        events.push(
          ...piSubagentTimelineEvents(descriptorId, [{ type: "assistant_message", text }]),
        );
      }
    }
    events.push(this.upsertFor(descriptorId, piSubagentStatusFromResult(isError), state));
    return events;
  }

  /** Mark every running subagent canceled (turn interrupted or session closing). */
  cancelAll(): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    for (const [toolCallId, state] of this.states) {
      if (state.reportedStatus === "running") {
        events.push(this.upsertFor(toolCallId, "canceled", state));
        state.reportedStatus = "canceled";
      }
    }
    this.states.clear();
    return events;
  }

  private upsert(toolCallId: string, status: PiSubagentStatus): AgentStreamEvent {
    return this.upsertFor(toolCallId, status, this.states.get(toolCallId)!);
  }

  private upsertFor(
    id: string,
    status: PiSubagentStatus,
    state: PiSubagentState | undefined,
  ): AgentStreamEvent {
    return {
      type: "provider_subagent",
      provider: PI_PROVIDER,
      event: {
        type: "upsert",
        id,
        title: state?.title ?? DEFAULT_SUBAGENT_TITLE,
        description: state?.description ?? null,
        status,
        toolCallId: id,
        ...(state?.subtitle ? { subtitle: state.subtitle } : {}),
      },
    };
  }
}

function sessionFilesOf(run: PiSubagentRunPayload | null): string[] {
  return (
    run?.results.flatMap((entry: PiSubagentResultEntry) =>
      typeof entry.sessionFile === "string" && entry.sessionFile ? [entry.sessionFile] : [],
    ) ?? []
  );
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
