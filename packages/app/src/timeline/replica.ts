import type { CachedTimeline } from "@/runtime/replica-cache";
import equal from "fast-deep-equal";
import type { AgentRemovalReason } from "@/utils/agent-directory-sync";
import { useSessionStore, type AgentTimelineCursorState } from "@/stores/session-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  acceptMessageSubmission,
  beginMessageSubmission,
  getSendingClientMessageIds,
  observeMessageSubmissionCanonical,
  rejectMessageSubmission,
  type MessageSubmissionRecord,
  type MessageSubmissionRejectionOutcome,
} from "@/composer/submission/model";
import {
  appendSubmittedUserMessage,
  handoffCreatedAgentUserMessageToStream,
  removeSubmittedUserMessage,
  replaceWithCanonicalStream,
  isUnreconciledLocalUserMessage,
  type StreamItem,
  type UserMessageItem,
} from "@/types/stream";
import {
  getInitDeferred,
  getInitKey,
  rejectInitDeferred,
  resolveInitDeferred,
} from "@/utils/agent-initialization";
import {
  processAgentStreamEvents,
  processTimelineResponse,
  processTimelineResponseCompletion,
  type AgentStreamReducerEvent,
  type AgentStreamReducerSnapshot,
  type ProcessTimelineResponseOutput,
} from "./session-stream-reducers";
import { isTimelineResumeSnapshotAuthoritative } from "./timeline-sync-plan";
import { TIMELINE_FETCH_PAGE_SIZE } from "./timeline-fetch-policy";

export type TimelineResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_agent_timeline_response" }
>["payload"];

export interface TimelinePageRequest {
  cursor: { epoch: string; endSeq: number } | null;
  replaceTail: boolean;
  initialization: Promise<void> | undefined;
}

export interface TimelineReplicaStorage {
  removeTimeline(serverId: string, agentId: string): void;
  readTimeline(serverId: string, agentId: string): Promise<CachedTimeline | undefined>;
  commitTimeline(
    serverId: string,
    agentId: string,
    timeline: CachedTimeline,
    requireCertified?: boolean,
  ): void;
}

interface TimelineRows {
  tail: StreamItem[];
  head: StreamItem[];
}

interface VerifiedTimeline extends TimelineRows {
  range: AgentTimelineCursorState | null;
  hasOlder: boolean;
}

interface AgentTimeline extends TimelineRows {
  // Pagination and coverage certainty do not change which older entries belong to the restart page.
  restartStartSeq: number | null;
  verified: VerifiedTimeline | null;
  // Loaded positions support navigation even when the displayed content is uncertifiable.
  displayRange: AgentTimelineCursorState | null;
  older: boolean;
  newer: boolean;
  synchronized: boolean;
  hasUnsequencedHistory: boolean;
  submissions: MessageSubmissionRecord[];
  preparation?: Promise<void>;
  restored: boolean;
  liveEpoch?: string;
}

interface PageEffects {
  recoverGap(
    agentId: string,
    cursor: { epoch: string; endSeq: number },
    observedSeq?: number,
  ): void;
  drainQueuedAgentMessage(agentId: string): void;
}

function acceptLiveDisplayEpoch(
  state: AgentTimeline,
  events: AgentStreamReducerEvent[],
): AgentStreamReducerEvent[] {
  if (state.synchronized) return events;
  // A connection's live epoch owns the display even while its first page is pending. The saved
  // epoch remains a restart baseline until a page establishes a replacement.
  const epoch = events.findLast((event) => event.event.type === "timeline" && event.epoch)?.epoch;
  if (!epoch) return events;
  const previousEpoch = state.liveEpoch ?? state.displayRange?.epoch;
  if (previousEpoch && previousEpoch !== epoch) {
    state.tail = state.tail.filter(
      (item) => item.kind === "user_message" && isUnreconciledLocalUserMessage(item),
    );
    state.head = state.head.filter(
      (item) => item.kind === "user_message" && isUnreconciledLocalUserMessage(item),
    );
    state.older = false;
    state.displayRange = null;
    state.restartStartSeq = null;
    state.hasUnsequencedHistory = false;
  }
  state.liveEpoch = epoch;
  return events.filter((event) => !event.epoch || event.epoch === epoch);
}

function applyVerifiedStreamEvents(
  state: AgentTimeline,
  events: AgentStreamReducerEvent[],
  display: ReturnType<typeof processAgentStreamEvents>,
): boolean {
  const previous = state.verified;
  const positioned = events.filter(
    ({ event, seq, epoch }) =>
      event.type !== "timeline" || (typeof seq === "number" && typeof epoch === "string"),
  );
  const unsequencedChanged =
    positioned.length !== events.length && (display.changedTail || display.changedHead);
  if (unsequencedChanged) state.hasUnsequencedHistory = true;
  if (!previous || !state.synchronized) return unsequencedChanged;
  const accepted =
    positioned.length === events.length &&
    state.tail === previous.tail &&
    state.head === previous.head
      ? display
      : processAgentStreamEvents({
          events: positioned,
          currentTail: previous.tail,
          currentHead: previous.head,
          currentCursor: previous.range ?? undefined,
          hasAuthoritativeBaseline: true,
          isDetached: state.newer,
        });
  const cursor = accepted.cursor;
  const changedEpoch =
    cursor !== null && previous.range !== null && cursor.epoch !== previous.range.epoch;
  if (changedEpoch) {
    Object.assign(display, retainPendingSubmissions(display, state));
    if (accepted !== display) Object.assign(accepted, retainPendingSubmissions(accepted, state));
    state.older = false;
    state.hasUnsequencedHistory = unsequencedChanged;
    state.restartStartSeq = cursor.startSeq;
  }
  state.verified = {
    tail: accepted.tail,
    head: accepted.head,
    range: accepted.cursorChanged ? cursor : previous.range,
    hasOlder: changedEpoch ? false : previous.hasOlder,
  };
  return (
    unsequencedChanged || accepted.changedTail || accepted.changedHead || accepted.cursorChanged
  );
}

function applySubmissionRows(
  state: AgentTimeline,
  transition: (rows: TimelineRows) => TimelineRows,
): boolean {
  const verified = state.verified;
  const shared = verified && state.tail === verified.tail && state.head === verified.head;
  const result = transition(state);
  const changed = result.tail !== state.tail || result.head !== state.head;
  if (verified) {
    const accepted = shared ? result : transition(verified);
    verified.tail = accepted.tail;
    verified.head = accepted.head;
  }
  state.tail = result.tail;
  state.head = result.head;
  return changed;
}

function isSupersededTail(
  payload: TimelineResponsePayload,
  current: AgentTimelineCursorState | null | undefined,
  requestedFrom: { epoch: string; endSeq: number } | null | undefined,
): boolean {
  if (payload.direction !== "tail" || payload.reset || payload.mergeWindow || payload.error)
    return false;
  // A head already behind the request's accepted cursor demonstrates a rewind. A head
  // passed by activity accepted during that request is an obsolete reply instead.
  return (
    requestedFrom !== undefined &&
    (requestedFrom === null ||
      requestedFrom.epoch !== payload.epoch ||
      payload.window.maxSeq >= requestedFrom.endSeq) &&
    current?.epoch === payload.epoch &&
    payload.window.maxSeq < current.endSeq
  );
}

function invalidatesDurableBaseline(
  payload: TimelineResponsePayload,
  result: ProcessTimelineResponseOutput,
  baseline: VerifiedTimeline | null,
): boolean {
  const completeReplacement =
    payload.direction === "tail" &&
    (payload.window.maxSeq < payload.window.minSeq ||
      (payload.startCursor?.seq === payload.window.minSeq &&
        payload.endCursor?.seq === payload.window.maxSeq));
  return Boolean(
    result.commit === "apply" &&
    completeReplacement &&
    (payload.reset ||
      (baseline?.range &&
        (payload.epoch !== baseline.range.epoch || payload.window.maxSeq < baseline.range.endSeq))),
  );
}

function applyAcceptedPageState(input: {
  state: AgentTimeline;
  payload: TimelineResponsePayload;
  result: ProcessTimelineResponseOutput;
  verified: VerifiedTimeline;
  replaceTail: boolean;
  synchronized: boolean;
}): void {
  const { state, payload, result, verified, synchronized } = input;
  const baseline = state.verified;
  const range = verified.range;
  const replacesWindow =
    input.replaceTail ||
    payload.reset ||
    !baseline?.range ||
    !range ||
    baseline.range.epoch !== range.epoch ||
    range.endSeq < baseline.range.endSeq;
  // Older pagination can extend an existing baseline, but cannot establish live coverage.
  if (payload.direction !== "before" || baseline) {
    if (replacesWindow) state.restartStartSeq = range?.startSeq ?? null;
    state.verified = verified;
    if (payload.direction !== "before") state.hasUnsequencedHistory = false;
  }
  state.tail = result.tail;
  state.head = result.head;
  if (result.cursorChanged) state.displayRange = result.cursor ?? null;
  if (result.older !== "unchanged") state.older = result.older === "available";
  if (payload.direction !== "before") state.newer = payload.hasNewer;
  if (synchronized) state.liveEpoch = payload.epoch;
  state.synchronized ||= synchronized;
  state.submissions = observeMessageSubmissionCanonical(
    state.submissions,
    result.acknowledgedClientMessageIds,
  );
}

/** Host-lived write authority. Zustand is its UI projection; disk is write-behind. */
export class TimelineReplica {
  private readonly agents = new Map<string, AgentTimeline>();
  private readonly removed = new Set<string>();
  private disposed = false;

  constructor(
    private serverId: string,
    private readonly storage: TimelineReplicaStorage,
  ) {}

  private state(agentId: string): AgentTimeline {
    const existing = this.agents.get(agentId);
    if (existing) return existing;
    const state: AgentTimeline = {
      tail: [],
      head: [],
      older: false,
      newer: false,
      synchronized: false,
      hasUnsequencedHistory: false,
      restored: false,
      restartStartSeq: null,
      verified: null,
      displayRange: null,
      submissions: [],
    };
    this.agents.set(agentId, state);
    return state;
  }

  private accepts(agentId: string): boolean {
    return !this.disposed && !this.removed.has(agentId);
  }

  prepare(agentId: string): Promise<void> {
    if (!this.accepts(agentId)) return Promise.resolve();
    const state = this.state(agentId);
    state.preparation ??= this.restore(agentId, state);
    return state.preparation;
  }

  private async restore(agentId: string, state: AgentTimeline): Promise<void> {
    const serverId = this.serverId;
    const stored = await this.storage.readTimeline(serverId, agentId);
    if (!this.accepts(agentId) || this.agents.get(agentId) !== state) return;
    // Identity transfer retires the old scoped read, even if it captured rows before rename.
    if (serverId !== this.serverId) return this.restore(agentId, state);
    state.restored = true;
    if (state.verified || !stored) {
      this.publish(agentId, state, {
        persist: Boolean(state.verified) || state.hasUnsequencedHistory,
        requireCertified: Boolean(stored?.range),
      });
      return;
    }
    const sameEpoch = !state.liveEpoch || !stored.range || state.liveEpoch === stored.range.epoch;
    const replacement = replaceWithCanonicalStream({
      canonical: sameEpoch ? stored.items : [],
      previousTail: state.tail,
      previousHead: state.head,
      sendingClientMessageIds: getSendingClientMessageIds(state.submissions),
      preserveContinuity: true,
      canonicalCoverage:
        sameEpoch && stored.range
          ? { epoch: stored.range.epoch, endSeq: stored.range.endSeq }
          : "rows-only",
    });
    Object.assign(state, {
      tail: replacement.tail,
      head: replacement.head,
      older: sameEpoch && stored.hasOlder,
      displayRange: sameEpoch ? stored.range : null,
    });
    if (stored.range) {
      state.restartStartSeq = stored.range.startSeq;
      state.verified = {
        tail: stored.items,
        head: [],
        range: stored.range,
        hasOlder: stored.hasOlder,
      };
    }
    state.submissions = observeMessageSubmissionCanonical(
      state.submissions,
      replacement.acknowledgedClientMessageIds,
    );
    this.publish(agentId, state, {
      persist: state.hasUnsequencedHistory,
      requireCertified: Boolean(stored.range),
    });
  }

  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined {
    if (!this.accepts(agentId)) return undefined;
    const range = this.state(agentId).verified?.range;
    return range ? { epoch: range.epoch, endSeq: range.endSeq } : undefined;
  }

  private streamSnapshot(agentId: string): AgentStreamReducerSnapshot {
    const state = this.state(agentId);
    return {
      currentTail: state.tail,
      currentHead: state.head,
      currentCursor: state.displayRange ?? undefined,
      // Before network synchronization, live activity can paint ahead of the saved range.
      hasAuthoritativeBaseline: state.synchronized,
      isDetached: state.synchronized && state.newer,
    };
  }

  applyEvents(
    agentId: string,
    events: AgentStreamReducerEvent[],
    recoverGap: PageEffects["recoverGap"],
  ): void {
    if (!this.accepts(agentId)) return;
    const state = this.state(agentId);
    events = acceptLiveDisplayEpoch(state, events);
    const display = processAgentStreamEvents({ events, ...this.streamSnapshot(agentId) });
    const previous = state.verified;
    const persist = applyVerifiedStreamEvents(state, events, display);
    if (display.cursorChanged) state.displayRange = display.cursor;
    state.tail = display.tail;
    state.head = display.head;
    state.submissions = observeMessageSubmissionCanonical(
      state.submissions,
      display.acknowledgedClientMessageIds,
    );
    this.publish(agentId, state, {
      persist: persist || !previous,
      requireCertified: Boolean(previous?.range && state.verified),
    });
    for (const effect of display.sideEffects) {
      if (effect.type === "catch_up") recoverGap(agentId, effect.cursor, effect.observedSeq);
    }
  }

  applyPage(
    payload: TimelineResponsePayload,
    effects: PageEffects,
    request?: TimelinePageRequest,
  ): void {
    const agentId = payload.agentId;
    if (!this.accepts(agentId)) return;
    const state = this.state(agentId);
    const initKey = getInitKey(this.serverId, agentId);
    const deferred = getInitDeferred(initKey);
    const session = useSessionStore.getState().sessions[this.serverId];
    const ownsInitialization = !request || request.initialization === deferred?.promise;
    const common = {
      payload,
      replaceTail: request?.replaceTail === true,
      currentCursor: state.displayRange ?? undefined,
      isInitializing: ownsInitialization && session?.initializingAgents.get(agentId) === true,
      hasActiveInitDeferred: ownsInitialization && Boolean(deferred),
      initRequestDirection: deferred?.requestDirection ?? ("tail" as const),
      sendingClientMessageIds: getSendingClientMessageIds(state.submissions),
    };
    if (isSupersededTail(payload, state.verified?.range, request?.cursor)) {
      const completion = processTimelineResponseCompletion(common);
      settleTimelineInitialization(this.serverId, agentId, completion);
      return;
    }
    const result = processTimelineResponse({
      ...common,
      currentTail: state.tail,
      currentHead: state.head,
    });
    if (result.error) {
      settleTimelineInitialization(this.serverId, agentId, result);
      return;
    }
    const baseline = state.verified;
    const invalidated = invalidatesDurableBaseline(payload, result, baseline);
    if (invalidated) {
      this.storage.removeTimeline(this.serverId, agentId);
      state.restored = true;
    }
    const synchronized = isTimelineResumeSnapshotAuthoritative({
      direction: payload.direction,
      hasNewer: payload.hasNewer,
      error: payload.error,
    });
    applyAcceptedPageState({
      state,
      payload,
      result,
      verified: reduceVerifiedPage(state, common, result),
      replaceTail: common.replaceTail,
      synchronized,
    });
    this.publish(agentId, state, {
      persist: payload.direction !== "before",
      requireCertified: !invalidated && Boolean(baseline?.range),
      synchronized,
    });
    if (!this.accepts(agentId)) return;
    recoverDisplayedGap(agentId, state, effects.recoverGap);
    finalizeProcessedTimeline({
      serverId: this.serverId,
      agentId,
      result,
      synchronized,
      ...effects,
    });
  }

  beginSubmission(agentId: string, message: UserMessageItem, tracked: boolean): void {
    if (!this.accepts(agentId)) return;
    const state = this.state(agentId);
    if (tracked) {
      if (!message.clientMessageId)
        throw new Error("Beginning a message submission requires client identity");
      state.submissions = beginMessageSubmission(state.submissions, {
        clientMessageId: message.clientMessageId,
      });
    }
    applySubmissionRows(state, (rows) => appendSubmittedUserMessage({ ...rows, message }));
    this.publish(agentId, state);
  }

  acceptSubmission(agentId: string, clientMessageId: string): void {
    if (!this.accepts(agentId)) return;
    const state = this.state(agentId);
    state.submissions = acceptMessageSubmission(state.submissions, clientMessageId);
    this.publish(agentId, state);
  }

  rejectSubmission(
    agentId: string,
    clientMessageId: string,
    tracked: boolean,
  ): MessageSubmissionRejectionOutcome {
    if (!this.accepts(agentId)) return "unknown";
    const state = this.state(agentId);
    const rejection = rejectMessageSubmission(state.submissions, clientMessageId);
    const outcome = tracked ? rejection.outcome : "rejected";
    state.submissions = rejection.submissions;
    if (outcome === "rejected") {
      applySubmissionRows(state, (rows) =>
        removeSubmittedUserMessage({ ...rows, clientMessageId }),
      );
    }
    this.publish(agentId, state);
    return outcome;
  }

  handoffSubmission(agentId: string, message: UserMessageItem): boolean {
    if (!this.accepts(agentId)) return false;
    const state = this.state(agentId);
    const changed = applySubmissionRows(state, (rows) =>
      handoffCreatedAgentUserMessageToStream({ ...rows, message }),
    );
    if (!changed) return false;
    this.publish(agentId, state, {
      persist: Boolean(state.verified),
      requireCertified: Boolean(state.verified?.range),
    });
    return true;
  }

  acceptAgent(agentId: string): void {
    if (!this.disposed) this.removed.delete(agentId);
  }

  remove(agentId: string, reason: AgentRemovalReason): void {
    this.removed.add(agentId);
    this.agents.delete(agentId);
    if (reason === "deleted") this.storage.removeTimeline(this.serverId, agentId);
    useSessionStore.getState().removeAgentTimeline(this.serverId, agentId);
  }

  reconcileServerId(serverId: string): void {
    this.serverId = serverId;
    for (const [agentId, state] of this.agents) {
      this.publish(agentId, state, { synchronized: state.synchronized });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.agents.clear();
  }

  private publish(
    agentId: string,
    state: AgentTimeline,
    options: { persist?: boolean; requireCertified?: boolean; synchronized?: boolean } = {},
  ): void {
    const { persist = false, requireCertified = false, synchronized = false } = options;
    // Unknown display content cannot certify disk, but does not revoke known source coverage.
    // While positioned catch-up is incomplete, keep its accepted durable baseline instead.
    const displayOnly = state.hasUnsequencedHistory && state.synchronized && !state.newer;
    const verified = displayOnly ? null : state.verified;
    const range = verified?.range ?? null;
    const durable: CachedTimeline | null =
      persist && (verified !== null || state.restored)
        ? {
            agentId,
            items: verified ? [...verified.tail, ...verified.head] : [...state.tail, ...state.head],
            range,
            hasOlder: Boolean(verified?.hasOlder),
          }
        : null;
    // Both outputs are determined before subscribers run; none can authorize persistence by
    // changing a mutable store flag between publication and the write-behind decision.
    if (durable) {
      const page = latestRestartPage(durable, state.restartStartSeq);
      if (page.range) state.restartStartSeq = page.range.startSeq;
      this.storage.commitTimeline(
        this.serverId,
        agentId,
        page,
        (requireCertified && !displayOnly) || !state.restored,
      );
    }
    useSessionStore.getState().applyAgentTimelineResponseState(this.serverId, agentId, {
      items: state.tail,
      head: state.head,
      range: state.displayRange,
      older: state.older ? "available" : "none",
      newer: state.newer,
      synchronized,
      submissions: state.submissions,
    });
  }
}

function latestRestartPage(
  timeline: CachedTimeline,
  restartStartSeq: number | null,
): CachedTimeline {
  const startOf = (item: StreamItem | undefined) =>
    item?.source?.startSeq ?? item?.timelineCursor?.seq;
  const candidates = timeline.items.filter(
    (item) => item.kind !== "user_message" || !isUnreconciledLocalUserMessage(item),
  );
  const items = candidates.filter(
    (item) =>
      restartStartSeq === null ||
      (startOf(item) ?? restartStartSeq) >= restartStartSeq ||
      // A prepend may complete the retained boundary message. Keep that whole item,
      // without admitting older tools merely because they finish inside the window.
      item.source?.chunks?.some((chunk) => chunk.seq === restartStartSeq),
  );
  const first = Math.max(0, items.length - TIMELINE_FETCH_PAGE_SIZE);
  const omitted = candidates.length > items.length || first > 0;
  const firstSource = startOf(items[first]);
  const floor = restartStartSeq ?? timeline.range?.startSeq;
  const startSeq = first > 0 ? firstSource : Math.min(floor ?? Infinity, firstSource ?? Infinity);
  const range =
    timeline.range && startSeq !== undefined && Number.isFinite(startSeq)
      ? { ...timeline.range, startSeq: Math.max(timeline.range.startSeq, startSeq) }
      : timeline.range;
  return {
    ...timeline,
    items: items.slice(first),
    range,
    hasOlder:
      timeline.hasOlder ||
      omitted ||
      Boolean(range && timeline.range && range.startSeq > timeline.range.startSeq),
  };
}

export function createTimelineReplica(input: {
  serverId: string;
  storage: TimelineReplicaStorage;
}): TimelineReplica {
  return new TimelineReplica(input.serverId, input.storage);
}
function retainPendingSubmissions(rows: TimelineRows, state: AgentTimeline): TimelineRows {
  const pending = getSendingClientMessageIds(state.submissions);
  for (const row of [...state.tail, ...state.head]) {
    if (
      row.kind !== "user_message" ||
      !row.clientMessageId ||
      !pending.includes(row.clientMessageId)
    )
      continue;
    rows = handoffCreatedAgentUserMessageToStream({ ...rows, message: row });
  }
  return rows;
}

function reduceVerifiedPage(
  state: AgentTimeline,
  common: Omit<Parameters<typeof processTimelineResponse>[0], "currentTail" | "currentHead">,
  display: ProcessTimelineResponseOutput,
): VerifiedTimeline {
  const baseline = state.verified;
  const currentCursor = baseline?.range ?? undefined;
  const shared =
    (baseline === null && state.tail.length === 0 && state.head.length === 0) ||
    (baseline?.tail === state.tail && baseline.head === state.head);
  let rows: TimelineRows = baseline ?? { tail: [], head: [] };
  for (const row of shared ? [] : [...state.tail, ...state.head]) {
    if (row.kind === "user_message" && isUnreconciledLocalUserMessage(row)) {
      rows = handoffCreatedAgentUserMessageToStream({ ...rows, message: row });
    }
  }
  const verified = shared
    ? display
    : processTimelineResponse({
        ...common,
        currentCursor,
        currentTail: rows.tail,
        currentHead: rows.head,
      });
  // Divergence ends when the accepted page reconciles the overlay. Subsequent events share
  // one reduction again; no consumer or synchronization flag decides row identity.
  if (!shared && equal([...verified.tail, ...verified.head], [...display.tail, ...display.head])) {
    verified.tail = display.tail;
    verified.head = display.head;
  }
  const range = verified.cursorChanged ? (verified.cursor ?? null) : (currentCursor ?? null);
  return {
    tail: verified.tail,
    head: verified.head,
    range,
    hasOlder: verified.older === "unchanged" ? state.older : verified.older === "available",
  };
}

function recoverDisplayedGap(
  agentId: string,
  state: AgentTimeline,
  recoverGap: PageEffects["recoverGap"],
): void {
  const range = state.verified?.range;
  if (!range) return;
  for (const row of [...state.tail, ...state.head]) {
    const cursor = row.timelineCursor;
    if (cursor?.epoch === range.epoch && cursor.seq > range.endSeq)
      recoverGap(agentId, range, cursor.seq);
  }
}

function clearAgentInitializingFlag(serverId: string, agentId: string): void {
  useSessionStore.getState().setInitializingAgents(serverId, (previous) => {
    if (previous.get(agentId) !== true) return previous;
    const next = new Map(previous);
    next.set(agentId, false);
    return next;
  });
}

function settleTimelineInitialization(
  serverId: string,
  agentId: string,
  result: Pick<ProcessTimelineResponseOutput, "clearInitializing" | "initResolution" | "error">,
): void {
  if (result.clearInitializing) clearAgentInitializingFlag(serverId, agentId);
  const key = getInitKey(serverId, agentId);
  if (result.initResolution === "resolve") resolveInitDeferred(key);
  if (result.initResolution === "reject" && result.error)
    rejectInitDeferred(key, new Error(result.error));
}

function finalizeProcessedTimeline(input: {
  serverId: string;
  agentId: string;
  result: ProcessTimelineResponseOutput;
  synchronized: boolean;
  recoverGap: (
    agentId: string,
    cursor: { epoch: string; endSeq: number },
    observedSeq?: number,
  ) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
}): void {
  for (const effect of input.result.sideEffects) {
    if (effect.type === "catch_up") {
      input.recoverGap(input.agentId, effect.cursor, effect.observedSeq);
    }
  }
  settleTimelineInitialization(input.serverId, input.agentId, input.result);
  if (input.synchronized) {
    useCreateFlowStore
      .getState()
      .clearByAgent({ serverId: input.serverId, agentId: input.agentId });
    const session = useSessionStore.getState().sessions[input.serverId];
    const agent = session?.agents.get(input.agentId) ?? session?.agentDetails.get(input.agentId);
    if (agent && agent.turn.phase === "idle") input.drainQueuedAgentMessage(input.agentId);
  }
}
