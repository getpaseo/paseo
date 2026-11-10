import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import { limitAgentTimelineItemContent } from "../../agent-timeline-content.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "../../agent-timeline-store-types.js";
import type { ProjectedTimelineRow } from "../../timeline-projection.js";
import type {
  AgentTimelineBackend,
  TimelineEntry,
  TimelineHead,
  TimelineScope,
  TimelineSeed,
} from "./backend.js";
import { UnknownTimelineError } from "./backend.js";
import { MemoryTimelineBackend } from "./memory-backend.js";

export type { TimelineEntry, TimelineHead, TimelineScope, TimelineSeed } from "./backend.js";

export interface TimelineCommit {
  row: AgentTimelineRow;
  epoch: string;
}

export type TimelineIngestResult =
  | { kind: "recorded"; row: AgentTimelineRow; epoch: string }
  /**
   * The row is committed but `publish` threw. The commit stands and nothing retries the
   * publication; ingesting the same submitted prompt again returns `duplicate`.
   */
  | { kind: "unpublished"; row: AgentTimelineRow; epoch: string; error: unknown }
  /** A submitted prompt with this `clientMessageId` is already recorded; nothing was published. */
  | { kind: "duplicate"; row: AgentTimelineRow; epoch: string };

export type TimelineAppendResult =
  | { kind: "recorded"; commits: TimelineCommit[] }
  /** The rows are committed but `publish` threw; see `TimelineIngestResult`. */
  | { kind: "unpublished"; commits: TimelineCommit[]; error: unknown };

export interface TimelineIngestOptions {
  /**
   * Runs right after the commit, before any later operation on the agent's timeline starts, so
   * publications leave in commit order. Not called when the commit fails or is a duplicate.
   * A throw does not undo the commit: the write resolves `unpublished` with the error.
   */
  publish?: (commit: TimelineCommit) => void;
}

export interface TimelineAppendOptions {
  /** See `TimelineIngestOptions.publish`. */
  publish?: (commits: TimelineCommit[]) => void;
}

/**
 * Owner of agent timeline history: item identity, sequence numbers, projection, and reads.
 *
 * Operations on one agent (its root history and its provider children) run in call order. A read
 * observes every write called before it, whether or not the caller awaited that write. A write
 * that fails rejects, consumes no sequence number, and publishes nothing.
 */
export class AgentTimeline {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly sizes = new Map<string, number>();

  constructor(private readonly backend: AgentTimelineBackend = new MemoryTimelineBackend()) {}

  describe(scope: TimelineScope): Promise<TimelineHead | null> {
    return this.run(scope, () => this.backend.head(scope));
  }

  /** Creates the scope's history with a new identity, replacing any existing history. */
  create(scope: TimelineScope, seed: TimelineSeed = {}): Promise<TimelineHead> {
    return this.run(scope, async () => this.track(scope, await this.backend.create(scope, seed)));
  }

  /** Returns the existing history, or creates an empty one. */
  open(scope: TimelineScope): Promise<TimelineHead> {
    return this.run(scope, async () => {
      const existing = await this.backend.head(scope);
      return existing ?? this.track(scope, await this.backend.create(scope, {}));
    });
  }

  delete(scope: TimelineScope): Promise<void> {
    return this.run(scope, async () => {
      await this.backend.delete(scope);
      this.sizes.delete(sizeKey(scope));
    });
  }

  ingest(
    scope: TimelineScope,
    entry: TimelineEntry,
    options?: TimelineIngestOptions,
  ): Promise<TimelineIngestResult> {
    return this.run(scope, async () => {
      const clientMessageId = submittedPromptId(entry.item);
      if (clientMessageId) {
        const existing = await this.backend.findSubmittedPrompt(scope, clientMessageId);
        if (existing) return { kind: "duplicate", row: existing, epoch: await this.epoch(scope) };
      }
      const [commit] = await this.commit(scope, [entry]);
      const failure = publishCommitted(options?.publish, commit);
      return failure
        ? { kind: "unpublished", ...commit, error: failure.error }
        : { kind: "recorded", ...commit };
    });
  }

  /** Appends provider history entries in one commit, without submitted-prompt deduplication. */
  append(
    scope: TimelineScope,
    entries: readonly TimelineEntry[],
    options?: TimelineAppendOptions,
  ): Promise<TimelineAppendResult> {
    return this.run(scope, async () => {
      const commits = entries.length === 0 ? [] : await this.commit(scope, entries);
      const failure = publishCommitted(options?.publish, commits);
      return failure
        ? { kind: "unpublished", commits, error: failure.error }
        : { kind: "recorded", commits };
    });
  }

  attachProviderMessageId(
    scope: TimelineScope,
    clientMessageId: string,
    providerMessageId: string,
  ): Promise<AgentTimelineRow | null> {
    return this.run(scope, () =>
      this.backend.attachProviderMessageId(scope, clientMessageId, providerMessageId),
    );
  }

  findSubmittedPrompt(
    scope: TimelineScope,
    clientMessageId: string,
  ): Promise<AgentTimelineRow | null> {
    return this.run(scope, () => this.backend.findSubmittedPrompt(scope, clientMessageId));
  }

  fetch(
    scope: TimelineScope,
    options: AgentTimelineFetchOptions = {},
  ): Promise<AgentTimelineFetchResult> {
    return this.run(scope, () => this.backend.fetch(scope, options));
  }

  readRows(scope: TimelineScope): Promise<ProjectedTimelineRow[]> {
    return this.run(scope, () => this.backend.readRows(scope));
  }

  lastItem(scope: TimelineScope): Promise<AgentTimelineItem | null> {
    return this.run(scope, () => this.backend.lastItem(scope));
  }

  /**
   * The text of the trailing run of assistant messages, joined in order (providers stream one
   * reply as several messages). Non-assistant items after the run are skipped; the first one
   * before it ends the run. Null when the history has no assistant message.
   */
  lastAssistantMessage(scope: TimelineScope): Promise<string | null> {
    return this.run(scope, () => this.backend.lastAssistantMessage(scope));
  }

  /**
   * Resolves once every operation called before it has finished, including its publication.
   * Callers use it so an event published outside the timeline cannot overtake queued writes.
   */
  settled(scope: TimelineScope): Promise<void> {
    return this.run(scope, settledOperation);
  }

  /** Projected row count as of the last committed write, for diagnostics. */
  residentSize(scope: TimelineScope): number | null {
    return this.sizes.get(sizeKey(scope)) ?? null;
  }

  private async commit(
    scope: TimelineScope,
    entries: readonly TimelineEntry[],
  ): Promise<TimelineCommit[]> {
    const bounded = entries.map((entry) => ({
      ...entry,
      item: limitAgentTimelineItemContent(entry.item),
    }));
    const { rows, head } = await this.backend.append(scope, bounded);
    this.track(scope, head);
    return rows.map((row) => ({ row, epoch: head.epoch }));
  }

  private async epoch(scope: TimelineScope): Promise<string> {
    const head = await this.backend.head(scope);
    if (!head) throw new UnknownTimelineError(scope);
    return head.epoch;
  }

  private track(scope: TimelineScope, head: TimelineHead): TimelineHead {
    this.sizes.set(sizeKey(scope), head.size);
    return head;
  }

  private run<T>(scope: TimelineScope, operation: () => T | Promise<T>): Promise<T> {
    const key = scope.agentId;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(settledOperation, settledOperation);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

function settledOperation(): void {}

interface PublishFailure {
  error: unknown;
}

/** Returns what `publish` threw, or null. A committed write stays committed either way. */
function publishCommitted<T>(
  publish: ((committed: T) => void) | undefined,
  committed: T,
): PublishFailure | null {
  try {
    publish?.(committed);
    return null;
  } catch (error) {
    return { error };
  }
}

function sizeKey(scope: TimelineScope): string {
  return scope.subagentId === undefined ? scope.agentId : `${scope.agentId}\0${scope.subagentId}`;
}

function submittedPromptId(item: AgentTimelineItem): string | null {
  return item.type === "user_message" && item.clientMessageId ? item.clientMessageId : null;
}
