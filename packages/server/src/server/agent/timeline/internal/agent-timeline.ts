import { randomUUID } from "node:crypto";
import type { AgentTimelineItem, ConversationRewindCut } from "../../agent-sdk-types.js";
import { limitAgentTimelineItemContent } from "../../agent-timeline-content.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "../../agent-timeline-store-types.js";
import type { ProjectedTimelineRow, TimelineRetirement } from "../../timeline-projection.js";
import type { ProviderSubagentDescriptor } from "../../provider-subagents/store.js";
import type {
  AgentTimelineBackend,
  TimelineChild,
  TimelineEntry,
  TimelineHead,
  TimelinePrompt,
  TimelineRewindIntent,
  TimelineScope,
  TimelineSeed,
} from "./backend.js";
import { UnknownTimelineError } from "./backend.js";
import { MemoryTimelineBackend } from "./memory-backend.js";
import { planProviderHistory } from "./provider-history.js";

export type {
  TimelineChild,
  TimelineEntry,
  TimelineHead,
  TimelineRewindIntent,
  TimelineScope,
  TimelineSeed,
} from "./backend.js";
export type { TimelineRetirement } from "../../timeline-projection.js";

export interface TimelineCommit {
  row: AgentTimelineRow;
  epoch: string;
  /** Rewinds applied to this history so far. */
  retirementCount: number;
}

export interface TimelineRetirementCommit {
  retirement: TimelineRetirement;
  /** The rows that left the active conversation. They stay stored. */
  retiredRows: ProjectedTimelineRow[];
  /** The provider children the retired rows spawned, and their descendants. They stay stored. */
  retiredChildIds: string[];
  epoch: string;
  retirementCount: number;
}

export type TimelineRewindCompletion =
  | ({ kind: "retired" } & TimelineRetirementCommit)
  /** Committed, but `publish` threw; see `TimelineIngestResult`. */
  | ({ kind: "unpublished"; error: unknown } & TimelineRetirementCommit)
  /** No rewind with this id is open: it completed or was abandoned. Nothing changed. */
  | { kind: "absent" };

/**
 * What the provider's own history says about an open rewind, judged against the active prompts.
 * `unknown` carries the reason the evidence does not decide it.
 */
export type TimelineRewindVerdict =
  | { kind: "unchanged" }
  | { kind: "applied"; cut: ConversationRewindCut }
  | { kind: "unknown"; reason: string }
  /** No rewind with this id is open. */
  | { kind: "absent" };

/** Another rewind is open on the history; it must settle first. */
export class TimelineRewindPendingError extends Error {
  constructor(readonly intent: TimelineRewindIntent) {
    super("Another rewind of this conversation has not settled");
    this.name = "TimelineRewindPendingError";
  }
}

/** The rewind target is not an active prompt: it never existed or a rewind already retired it. */
export class TimelineRewindTargetError extends Error {
  constructor(readonly messageId: string) {
    super("The message to rewind to is no longer in the conversation");
    this.name = "TimelineRewindTargetError";
  }
}

/** The provider's cut does not resolve to a prompt at or before the target. */
export class TimelineRewindBoundaryError extends Error {
  constructor(readonly intent: TimelineRewindIntent) {
    super("The provider's rewind boundary does not match this conversation");
    this.name = "TimelineRewindBoundaryError";
  }
}

export type TimelineIngestResult =
  | ({ kind: "recorded" } & TimelineCommit)
  /**
   * The row is committed but `publish` threw. The commit stands and nothing retries the
   * publication; ingesting the same submitted prompt again returns `duplicate`.
   */
  | ({ kind: "unpublished"; error: unknown } & TimelineCommit)
  /** A submitted prompt with this `clientMessageId` is already recorded; nothing was published. */
  | ({ kind: "duplicate" } & TimelineCommit)
  /** Late output for a retired item or turn. Nothing was recorded or published. */
  | { kind: "dropped" };

export type TimelineAppendResult =
  | { kind: "recorded"; commits: TimelineCommit[] }
  /** The rows are committed but `publish` threw; see `TimelineIngestResult`. */
  | { kind: "unpublished"; commits: TimelineCommit[]; error: unknown };

export type TimelineImportResult =
  | { kind: "imported"; head: TimelineHead }
  /** The scope already has history; nothing changed. */
  | { kind: "present"; head: TimelineHead };

export type TimelineReconcileResult =
  /** The provider's history holds what the owned history holds. Nothing changed. */
  | { kind: "unchanged" }
  /** The provider continued the conversation; its turns were appended. */
  | { kind: "appended"; commits: TimelineCommit[] }
  /** Committed, but `publish` threw; see `TimelineIngestResult`. */
  | { kind: "unpublished"; commits: TimelineCommit[]; error: unknown }
  /** The provider's history disagrees with the owned history, which is kept unchanged. */
  | { kind: "diverged"; reason: string }
  /** A rewind is open; it settles first. Nothing changed. */
  | { kind: "rewind_open" };

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

  /**
   * Creates the scope's history from the provider's, in one commit, when the scope has none.
   * Existing history is left as it is, so repeating an import adds nothing.
   */
  importHistory(
    scope: TimelineScope,
    entries: readonly TimelineEntry[],
    options: { timestamp?: string } = {},
  ): Promise<TimelineImportResult> {
    return this.run(scope, async () => {
      const existing = await this.backend.head(scope);
      if (existing) return { kind: "present", head: existing };
      const head = await this.backend.create(scope, {
        entries: entries.map(boundEntry),
        timestamp: options.timestamp,
      });
      return { kind: "imported", head: this.track(scope, head) };
    });
  }

  /**
   * Appends what the provider's history has after the owned history, which is never changed. When
   * the histories differ in any compared content the result is `diverged` and nothing is written;
   * see `planProviderHistory` for what is compared and what continuation is supported.
   */
  reconcileProviderHistory(
    scope: TimelineScope,
    entries: readonly TimelineEntry[],
    options?: { publish?: (commits: TimelineCommit[]) => void },
  ): Promise<TimelineReconcileResult> {
    return this.run(scope, async () => {
      const head = await this.requireHead(scope);
      if (head.rewind) return { kind: "rewind_open" };
      const plan = planProviderHistory({
        rows: await this.backend.readRows(scope),
        prompts: await this.backend.prompts(scope),
        provider: entries.map(boundEntry),
      });
      if (plan.kind !== "append") return plan;
      const commits = await this.commit(scope, plan.entries);
      const failure = publishCommitted(options?.publish, commits);
      return failure
        ? { kind: "unpublished", commits, error: failure.error }
        : { kind: "appended", commits };
    });
  }

  /** The agent's provider children, retired ones included. */
  listChildren(agentId: string): Promise<TimelineChild[]> {
    return this.run({ agentId }, () => this.backend.children(agentId));
  }

  /**
   * Stores the descriptor `update` derives from the child's current one, creating the child when
   * absent. A retired child is left as it is and resolves null.
   */
  recordChild(
    scope: TimelineScope,
    update: (previous: ProviderSubagentDescriptor | null) => ProviderSubagentDescriptor,
  ): Promise<ProviderSubagentDescriptor | null> {
    return this.run(scope, async () => {
      const child = await this.backend.child(scope);
      if (child?.retired) return null;
      const descriptor = update(child?.descriptor ?? null);
      await this.backend.setChild(scope, descriptor);
      return descriptor;
    });
  }

  /** Appends to a child's history, creating the child when absent. A retired child resolves null. */
  recordChildEntries(
    scope: TimelineScope,
    entries: readonly TimelineEntry[],
  ): Promise<TimelineCommit[] | null> {
    return this.run(scope, async () => {
      const child = await this.backend.child(scope);
      if (child?.retired) return null;
      if (!child) this.track(scope, await this.backend.create(scope, {}));
      return entries.length === 0 ? [] : await this.commit(scope, entries);
    });
  }

  /** Deletes a child's history. A retired child stays stored and resolves false. */
  removeChild(scope: TimelineScope): Promise<boolean> {
    return this.run(scope, async () => {
      const child = await this.backend.child(scope);
      if (child?.retired) return false;
      await this.backend.delete(scope);
      this.sizes.delete(sizeKey(scope));
      return true;
    });
  }

  /** Deleting an agent's root history deletes all of its children's too. */
  delete(scope: TimelineScope): Promise<void> {
    return this.run(scope, async () => {
      await this.backend.delete(scope);
      this.sizes.delete(sizeKey(scope));
      if (scope.subagentId !== undefined) return;
      const childPrefix = sizeKey({ agentId: scope.agentId, subagentId: "" });
      for (const key of this.sizes.keys()) {
        if (key.startsWith(childPrefix)) this.sizes.delete(key);
      }
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
        if (existing) {
          const head = await this.requireHead(scope);
          return {
            kind: "duplicate",
            row: existing,
            epoch: head.epoch,
            retirementCount: head.retirementCount,
          };
        }
      }
      if (await this.backend.isRetired(scope, entry)) return { kind: "dropped" };
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
   * Opens a rewind to before the active prompt `messageId`. While it is open, `describe` reports it,
   * and a second rewind is refused until this one completes or is abandoned.
   */
  beginRewind(scope: TimelineScope, messageId: string): Promise<TimelineRewindIntent> {
    return this.run(scope, async () => {
      const head = await this.requireHead(scope);
      if (head.rewind) throw new TimelineRewindPendingError(head.rewind);
      const target = (await this.backend.prompts(scope)).find(
        (prompt) => prompt.messageId === messageId,
      );
      if (!target) throw new TimelineRewindTargetError(messageId);
      const intent: TimelineRewindIntent = {
        id: randomUUID(),
        messageId,
        targetSeq: target.seqStart,
      };
      await this.backend.setRewind(scope, intent);
      return intent;
    });
  }

  /** Records that the provider applied the rewind, before the retirement is committed. */
  recordRewindCut(
    scope: TimelineScope,
    intentId: string,
    cut: ConversationRewindCut,
  ): Promise<TimelineRewindIntent | null> {
    return this.run(scope, async () => {
      const head = await this.requireHead(scope);
      if (head.rewind?.id !== intentId) return null;
      const intent = { ...head.rewind, cut };
      await this.backend.setRewind(scope, intent);
      return intent;
    });
  }

  /** Closes a rewind the provider is known not to have applied. History is unchanged. */
  abandonRewind(scope: TimelineScope, intentId: string): Promise<void> {
    return this.run(scope, async () => {
      const head = await this.requireHead(scope);
      if (head.rewind?.id === intentId) await this.backend.setRewind(scope, null);
    });
  }

  /**
   * Judges an open rewind from the prompt ids the provider's current history holds, in order.
   * Changes nothing; the caller settles the rewind from the verdict.
   */
  judgeRewind(
    scope: TimelineScope,
    intentId: string,
    providerPromptIds: readonly string[],
  ): Promise<TimelineRewindVerdict> {
    return this.run(scope, async () => {
      const intent = (await this.requireHead(scope)).rewind;
      if (intent?.id !== intentId) return { kind: "absent" };
      return judgeRewindEvidence(intent, await this.backend.prompts(scope), providerPromptIds);
    });
  }

  /**
   * Retires the turns the recorded cut removed, and closes the rewind, in one commit. Completing a
   * rewind that is no longer open changes nothing, so a repeat cannot retire later turns.
   */
  completeRewind(
    scope: TimelineScope,
    intentId: string,
    options?: { publish?: (commit: TimelineRetirementCommit) => void },
  ): Promise<TimelineRewindCompletion> {
    return this.run(scope, async () => {
      const head = await this.requireHead(scope);
      const intent = head.rewind;
      if (intent?.id !== intentId) return { kind: "absent" };
      if (!intent.cut) throw new Error("Cannot complete a rewind before its provider outcome");
      const retireFromSeq = resolveRetireFromSeq(intent, await this.backend.prompts(scope));
      if (retireFromSeq === null) throw new TimelineRewindBoundaryError(intent);
      const result = await this.backend.retire(scope, {
        retireFromSeq,
        selectChildren: childrenSpawnedBy,
      });
      this.track(scope, result.head);
      const commit: TimelineRetirementCommit = {
        retirement: result.retirement,
        retiredRows: result.retiredRows,
        retiredChildIds: result.retiredChildIds,
        epoch: result.head.epoch,
        retirementCount: result.head.retirementCount,
      };
      const failure = publishCommitted(options?.publish, commit);
      return failure
        ? { kind: "unpublished", error: failure.error, ...commit }
        : { kind: "retired", ...commit };
    });
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
    const { rows, head } = await this.backend.append(scope, entries.map(boundEntry));
    this.track(scope, head);
    return rows.map((row) => ({
      row,
      epoch: head.epoch,
      retirementCount: head.retirementCount,
    }));
  }

  private async requireHead(scope: TimelineScope): Promise<TimelineHead> {
    const head = await this.backend.head(scope);
    if (!head) throw new UnknownTimelineError(scope);
    return head;
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

function boundEntry(entry: TimelineEntry): TimelineEntry {
  return { ...entry, item: limitAgentTimelineItemContent(entry.item) };
}

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

/**
 * The anchor where retirement starts: the target for `at_target`; for `after`, the first active
 * prompt after the retained one. Null when the cut does not resolve at or before the target.
 * Prompts without a provider id (never acknowledged) are retired with the turns around them.
 */
function resolveRetireFromSeq(
  intent: TimelineRewindIntent,
  prompts: readonly TimelinePrompt[],
): number | null {
  const cut = intent.cut;
  if (!cut) return null;
  let retireFromSeq: number | undefined;
  if (cut.kind === "at_target") {
    retireFromSeq = intent.targetSeq;
  } else if (cut.retainedMessageId === null) {
    retireFromSeq = prompts[0]?.seqStart;
  } else {
    const retainedId = cut.retainedMessageId;
    const retained = prompts.findIndex(
      (prompt) => (prompt.providerMessageId ?? prompt.messageId) === retainedId,
    );
    retireFromSeq = retained < 0 ? undefined : prompts[retained + 1]?.seqStart;
  }
  return retireFromSeq !== undefined && retireFromSeq <= intent.targetSeq ? retireFromSeq : null;
}

/**
 * The provider's prompts must be, in order, a prefix of the active prompts it has acknowledged.
 * All of them: the rewind did not happen. A prefix ending before the target: it happened, keeping
 * that prefix. Anything else, including an empty history that may mean "no replay", is unknown.
 */
function judgeRewindEvidence(
  intent: TimelineRewindIntent,
  prompts: readonly TimelinePrompt[],
  providerPromptIds: readonly string[],
): TimelineRewindVerdict {
  const known = prompts.filter((prompt) => !prompt.submitted || prompt.providerMessageId);
  const keys = known.map((prompt) => prompt.providerMessageId ?? prompt.messageId);
  if (providerPromptIds.length === 0) {
    return { kind: "unknown", reason: "The provider history has no prompts" };
  }
  const isPrefix = providerPromptIds.every((id, index) => keys[index] === id);
  if (!isPrefix) {
    return { kind: "unknown", reason: "The provider history differs from Paseo's" };
  }
  if (providerPromptIds.length === keys.length) return { kind: "unchanged" };
  const target = known.findIndex((prompt) => prompt.messageId === intent.messageId);
  if (target < 0 || providerPromptIds.length > target) {
    return { kind: "unknown", reason: "The provider history ends after the rewind target" };
  }
  return {
    kind: "applied",
    cut: { kind: "after", retainedMessageId: providerPromptIds[providerPromptIds.length - 1] },
  };
}

/** The listed children that retired tool calls spawned, and their descendants. */
function childrenSpawnedBy(
  retiredRows: readonly ProjectedTimelineRow[],
  children: readonly TimelineChild[],
): string[] {
  const toolCallIds = new Set(
    retiredRows.flatMap((row) => (row.item.type === "tool_call" ? [row.item.callId] : [])),
  );
  const listed = children.flatMap((child) =>
    !child.retired && child.descriptor ? [child.descriptor] : [],
  );
  const retired = new Set(
    listed
      .filter((child) => child.toolCallId !== null && toolCallIds.has(child.toolCallId))
      .map((child) => child.id),
  );
  let grew = retired.size > 0;
  while (grew) {
    grew = false;
    for (const child of listed) {
      if (retired.has(child.id) || child.parentSubagentId === null) continue;
      if (!retired.has(child.parentSubagentId)) continue;
      retired.add(child.id);
      grew = true;
    }
  }
  return [...retired];
}

function sizeKey(scope: TimelineScope): string {
  return scope.subagentId === undefined ? scope.agentId : `${scope.agentId}\0${scope.subagentId}`;
}

function submittedPromptId(item: AgentTimelineItem): string | null {
  return item.type === "user_message" && item.clientMessageId ? item.clientMessageId : null;
}
