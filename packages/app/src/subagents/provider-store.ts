import type {
  AgentStreamEventPayload,
  ProviderSubagentDescriptorPayload,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { DaemonConnectionError, type DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { create } from "zustand";
import { applyStreamEvent } from "@/types/stream";
import {
  processTimelineResponse,
  processAgentStreamEvent,
  type TimelineCursor,
} from "@/timeline/session-stream-reducers";
import type { StreamItem } from "@/types/stream";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

export interface ProviderSubagentTimelineState {
  tail: StreamItem[];
  head: StreamItem[];
  epoch: string | null;
  lastSeq: number;
  hasOlder: boolean;
  cursor: TimelineCursor | undefined;
  needsRefresh: boolean;
}

interface ProviderSubagentState {
  descriptors: Map<string, ProviderSubagentDescriptorPayload>;
  timelines: Map<string, ProviderSubagentTimelineState>;
  hiddenFromTrack: Set<string>;
  /** Parents whose list this client asked for, so a resubscribed update feed can catch them up. */
  trackedParents: Set<string>;
  trackParent(serverId: string, parentAgentId: string): void;
  hideFromTrack(serverId: string, parentAgentId: string, subagentIds: readonly string[]): void;
  replaceList(
    serverId: string,
    parentAgentId: string,
    subagents: ProviderSubagentDescriptorPayload[],
    freshness?: ProviderSubagentListFreshness,
  ): void;
  applyUpdate(
    serverId: string,
    payload: Extract<
      SessionOutboundMessage,
      { type: "agent.provider_subagents.update" }
    >["payload"],
  ): void;
  replaceTimeline(
    serverId: string,
    payload: Extract<
      SessionOutboundMessage,
      { type: "agent.provider_subagents.timeline.get.response" }
    >["payload"],
  ): void;
}

export function providerSubagentKey(
  serverId: string,
  parentAgentId: string,
  subagentId: string,
): string {
  return `${serverId}\0${parentAgentId}\0${subagentId}`;
}

export function providerSubagentLifecycleStatus(
  status: ProviderSubagentDescriptorPayload["status"],
): AgentLifecycleStatus {
  if (status === "running") return "running";
  if (status === "failed") return "error";
  return "idle";
}

interface ProviderSubagentListClient {
  listProviderSubagents: (
    parentAgentId: string,
  ) => Promise<{ subagents: ProviderSubagentDescriptorPayload[] }>;
}

interface InflightProviderSubagentList {
  epoch: number;
  promise: Promise<void>;
}

const pendingListRequests = new WeakMap<
  ProviderSubagentListClient,
  Map<string, InflightProviderSubagentList>
>();
const loadedParents = new WeakMap<ProviderSubagentListClient, Set<string>>();
const loadEpochByClient = new WeakMap<ProviderSubagentListClient, number>();
const mountedParents = new WeakMap<ProviderSubagentListClient, Map<string, number>>();

let listWriteGeneration = 0;
let inFlightLists = 0;
const liveGenerationByKey = new Map<string, number>();
const removedGenerationByKey = new Map<string, number>();

function noteLiveDescriptor(key: string): void {
  listWriteGeneration += 1;
  // A stamp only matters for a list that is already open. Idle writes would never beat
  // the next snapshot, and keeping them grows these maps for the life of the app.
  if (inFlightLists === 0) return;
  liveGenerationByKey.set(key, listWriteGeneration);
  removedGenerationByKey.delete(key);
}

function noteRemovedDescriptor(key: string): void {
  listWriteGeneration += 1;
  if (inFlightLists === 0) return;
  liveGenerationByKey.delete(key);
  removedGenerationByKey.set(key, listWriteGeneration);
}

function finishListRequest(): void {
  if (inFlightLists > 0) inFlightLists -= 1;
  if (inFlightLists > 0) return;
  liveGenerationByKey.clear();
  removedGenerationByKey.clear();
}

function clientLoadEpoch(client: ProviderSubagentListClient): number {
  return loadEpochByClient.get(client) ?? 0;
}

/** Drops list-freshness stamps so one test cannot leak into the next. */
export function resetProviderSubagentListFreshness(): void {
  listWriteGeneration = 0;
  inFlightLists = 0;
  liveGenerationByKey.clear();
  removedGenerationByKey.clear();
}

export function providerSubagentFreshnessSize(): { live: number; removed: number } {
  return { live: liveGenerationByKey.size, removed: removedGenerationByKey.size };
}

export interface ProviderSubagentListFreshness {
  /** Writes after this generation happened while the list request was in flight. */
  snapshotGeneration: number;
}

export function refreshProviderSubagents(
  client: ProviderSubagentListClient,
  serverId: string,
  parentAgentId: string,
  options?: { once?: boolean },
): Promise<void> {
  const requestKey = `${serverId}\0${parentAgentId}`;
  if (options?.once && loadedParents.get(client)?.has(requestKey)) {
    return Promise.resolve();
  }
  let clientRequests = pendingListRequests.get(client);
  if (!clientRequests) {
    clientRequests = new Map();
    pendingListRequests.set(client, clientRequests);
  }
  const epoch = clientLoadEpoch(client);
  const pending = clientRequests.get(requestKey);
  if (pending?.epoch === epoch) return pending.promise;

  useProviderSubagentStore.getState().trackParent(serverId, parentAgentId);
  inFlightLists += 1;
  const snapshotGeneration = listWriteGeneration;
  const entry: InflightProviderSubagentList = {
    epoch,
    promise: Promise.resolve(),
  };
  entry.promise = client
    .listProviderSubagents(parentAgentId)
    .then((payload) => {
      if (clientLoadEpoch(client) !== epoch) return undefined;
      useProviderSubagentStore.getState().replaceList(serverId, parentAgentId, payload.subagents, {
        snapshotGeneration,
      });
      let loaded = loadedParents.get(client);
      if (!loaded) {
        loaded = new Set();
        loadedParents.set(client, loaded);
      }
      loaded.add(requestKey);
      return undefined;
    })
    .finally(() => {
      finishListRequest();
      if (clientRequests?.get(requestKey) === entry) clientRequests.delete(requestKey);
    });
  clientRequests.set(requestKey, entry);
  return entry.promise;
}

function parentRequestKey(serverId: string, parentAgentId: string): string {
  return `${serverId}\0${parentAgentId}`;
}

/**
 * Keeps a parent on the reconnect refresh list. Several surfaces can watch the same parent.
 */
export function watchProviderSubagentParent(
  client: ProviderSubagentListClient,
  serverId: string,
  parentAgentId: string,
): () => void {
  const requestKey = parentRequestKey(serverId, parentAgentId);
  let mounted = mountedParents.get(client);
  if (!mounted) {
    mounted = new Map();
    mountedParents.set(client, mounted);
  }
  mounted.set(requestKey, (mounted.get(requestKey) ?? 0) + 1);
  void refreshProviderSubagents(client, serverId, parentAgentId, { once: true }).catch(
    () => undefined,
  );
  return () => {
    const current = mountedParents.get(client);
    if (!current) return;
    const next = (current.get(requestKey) ?? 0) - 1;
    if (next <= 0) current.delete(requestKey);
    else current.set(requestKey, next);
  };
}

/** Drops the once-cache and asks again for parents that are still on screen. */
export function invalidateProviderSubagentLoads(client: ProviderSubagentListClient): void {
  loadEpochByClient.set(client, clientLoadEpoch(client) + 1);
  loadedParents.get(client)?.clear();
  const mounted = mountedParents.get(client);
  if (!mounted) return;
  for (const requestKey of mounted.keys()) {
    const splitAt = requestKey.indexOf("\0");
    void refreshProviderSubagents(
      client,
      requestKey.slice(0, splitAt),
      requestKey.slice(splitAt + 1),
    ).catch(() => undefined);
  }
}

function parentPrefix(serverId: string, parentAgentId: string): string {
  return `${serverId}\0${parentAgentId}\0`;
}

/**
 * Updates are not replayed across a reconnect, so a child that finished or started while the
 * update feed was down stays stale until its parent is listed again. Call this once the feed has
 * resubscribed, so every update after the list is delivered.
 */
export async function resyncProviderSubagents(
  client: ProviderSubagentListClient,
  serverId: string,
): Promise<void> {
  const serverPrefix = `${serverId}\0`;
  const parentAgentIds = [...useProviderSubagentStore.getState().trackedParents]
    .filter((key) => key.startsWith(serverPrefix))
    .map((key) => key.slice(serverPrefix.length, -1));
  await Promise.all(
    parentAgentIds.map((parentAgentId) =>
      // A parent that was archived meanwhile has nothing left to catch up.
      refreshProviderSubagents(client, serverId, parentAgentId).catch(() => undefined),
    ),
  );
}

const EMPTY_TIMELINE: ProviderSubagentTimelineState = {
  tail: [],
  head: [],
  epoch: null,
  lastSeq: 0,
  hasOlder: false,
  cursor: undefined,
  needsRefresh: false,
};

function providerSubagentTerminalEvent(
  subagent: ProviderSubagentDescriptorPayload,
): AgentStreamEventPayload | null {
  if (subagent.status === "running") {
    return null;
  }
  if (subagent.status === "failed") {
    return { type: "turn_failed", provider: subagent.provider, error: "Subagent failed" };
  }
  if (subagent.status === "canceled") {
    return { type: "turn_canceled", provider: subagent.provider, reason: "canceled" };
  }
  return { type: "turn_completed", provider: subagent.provider };
}

function settleTimeline(
  timeline: ProviderSubagentTimelineState,
  descriptor?: ProviderSubagentDescriptorPayload,
): ProviderSubagentTimelineState {
  const event = descriptor ? providerSubagentTerminalEvent(descriptor) : null;
  if (!event || !descriptor) return timeline;
  return {
    ...timeline,
    ...applyStreamEvent({
      tail: timeline.tail,
      head: timeline.head,
      event,
      timestamp: new Date(descriptor.updatedAt),
    }),
  };
}

function keepsLiveDescriptor(
  current: ProviderSubagentDescriptorPayload | undefined,
  listed: ProviderSubagentDescriptorPayload,
  liveGeneration: number,
  snapshotGeneration: number,
): boolean {
  if (!current) return false;
  if (current.updatedAt > listed.updatedAt) return true;
  return current.updatedAt === listed.updatedAt && liveGeneration > snapshotGeneration;
}

function descriptorsAfterFreshList(
  previous: ReadonlyMap<string, ProviderSubagentDescriptorPayload>,
  listed: ReadonlyMap<string, ProviderSubagentDescriptorPayload>,
  prefix: string,
  snapshotGeneration: number,
): Map<string, ProviderSubagentDescriptorPayload> {
  const descriptors = new Map(previous);
  for (const key of previous.keys()) {
    if (!key.startsWith(prefix) || listed.has(key)) continue;
    if ((liveGenerationByKey.get(key) ?? 0) <= snapshotGeneration) descriptors.delete(key);
  }
  for (const [key, subagent] of listed) {
    if ((removedGenerationByKey.get(key) ?? 0) > snapshotGeneration) {
      descriptors.delete(key);
      continue;
    }
    const current = previous.get(key);
    const liveGeneration = liveGenerationByKey.get(key) ?? 0;
    if (keepsLiveDescriptor(current, subagent, liveGeneration, snapshotGeneration)) continue;
    descriptors.set(key, subagent);
    liveGenerationByKey.set(key, snapshotGeneration);
    removedGenerationByKey.delete(key);
  }
  return descriptors;
}

function descriptorsAfterFullList(
  previous: ReadonlyMap<string, ProviderSubagentDescriptorPayload>,
  listed: ReadonlyMap<string, ProviderSubagentDescriptorPayload>,
  prefix: string,
): Map<string, ProviderSubagentDescriptorPayload> {
  const descriptors = new Map(previous);
  for (const key of previous.keys()) {
    if (key.startsWith(prefix) && !listed.has(key)) {
      descriptors.delete(key);
      noteRemovedDescriptor(key);
    }
  }
  for (const [key, subagent] of listed) {
    descriptors.set(key, subagent);
    noteLiveDescriptor(key);
  }
  return descriptors;
}

function unhideRunningChildren(
  hiddenFromTrack: ReadonlySet<string>,
  descriptors: ReadonlyMap<string, ProviderSubagentDescriptorPayload>,
  prefix: string,
): Set<string> {
  const next = new Set(hiddenFromTrack);
  for (const [key, subagent] of descriptors) {
    if (key.startsWith(prefix) && subagent.status === "running") next.delete(key);
  }
  return next;
}

function timelinesAfterList(
  previousTimelines: ReadonlyMap<string, ProviderSubagentTimelineState>,
  previousDescriptors: ReadonlyMap<string, ProviderSubagentDescriptorPayload>,
  descriptors: ReadonlyMap<string, ProviderSubagentDescriptorPayload>,
  prefix: string,
): Map<string, ProviderSubagentTimelineState> {
  const retainedKeys = new Set(descriptors.keys());
  const timelines = new Map(
    [...previousTimelines].filter(([key]) => !key.startsWith(prefix) || retainedKeys.has(key)),
  );
  for (const [key, subagent] of descriptors) {
    if (!key.startsWith(prefix)) continue;
    const current = timelines.get(key);
    const prior = previousDescriptors.get(key);
    if (current && prior?.status !== subagent.status) {
      timelines.set(key, settleTimeline(current, subagent));
    }
  }
  return timelines;
}

export const useProviderSubagentStore = create<ProviderSubagentState>((set) => ({
  descriptors: new Map(),
  timelines: new Map(),
  hiddenFromTrack: new Set(),
  trackedParents: new Set(),
  trackParent(serverId, parentAgentId) {
    set((state) => {
      const prefix = parentPrefix(serverId, parentAgentId);
      if (state.trackedParents.has(prefix)) return state;
      return { trackedParents: new Set(state.trackedParents).add(prefix) };
    });
  },
  hideFromTrack(serverId, parentAgentId, subagentIds) {
    set((state) => {
      const hiddenFromTrack = new Set(state.hiddenFromTrack);
      for (const subagentId of subagentIds) {
        const key = providerSubagentKey(serverId, parentAgentId, subagentId);
        if (state.descriptors.get(key)?.status !== "running") hiddenFromTrack.add(key);
      }
      return { hiddenFromTrack };
    });
  },
  replaceList(serverId, parentAgentId, subagents, freshness) {
    set((state) => {
      const prefix = parentPrefix(serverId, parentAgentId);
      const listed = new Map(
        subagents.map((subagent) => [
          providerSubagentKey(serverId, parentAgentId, subagent.id),
          subagent,
        ]),
      );
      const descriptors = freshness
        ? descriptorsAfterFreshList(state.descriptors, listed, prefix, freshness.snapshotGeneration)
        : descriptorsAfterFullList(state.descriptors, listed, prefix);
      return {
        descriptors,
        hiddenFromTrack: unhideRunningChildren(state.hiddenFromTrack, descriptors, prefix),
        timelines: timelinesAfterList(state.timelines, state.descriptors, descriptors, prefix),
      };
    });
  },
  applyUpdate(serverId, payload) {
    set((state) => {
      if (payload.kind === "upsert") {
        const key = providerSubagentKey(
          serverId,
          payload.subagent.parentAgentId,
          payload.subagent.id,
        );
        noteLiveDescriptor(key);
        const descriptors = new Map(state.descriptors);
        const hiddenFromTrack = new Set(state.hiddenFromTrack);
        const previous = descriptors.get(key);
        descriptors.set(key, payload.subagent);
        if (payload.subagent.status === "running") {
          hiddenFromTrack.delete(key);
        }
        let timelines = state.timelines;
        const current = state.timelines.get(key);
        if (current && previous?.status !== payload.subagent.status) {
          timelines = new Map(state.timelines);
          timelines.set(key, settleTimeline(current, payload.subagent));
        }
        return { descriptors, timelines, hiddenFromTrack };
      }
      if (payload.kind === "remove") {
        const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
        noteRemovedDescriptor(key);
        const descriptors = new Map(state.descriptors);
        descriptors.delete(key);
        const timelines = new Map(state.timelines);
        timelines.delete(key);
        return { descriptors, timelines };
      }
      const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
      const existing = state.timelines.get(key);
      if (existing?.epoch && existing.epoch !== payload.epoch) {
        return state;
      }
      const current = existing ?? EMPTY_TIMELINE;
      if (payload.seq <= current.lastSeq) {
        return state;
      }
      const next = processAgentStreamEvent({
        currentTail: current.tail,
        currentHead: current.head,
        currentCursor: current.cursor,
        hasAuthoritativeBaseline: current.cursor !== undefined,
        event: { type: "timeline", provider: payload.provider, item: payload.item },
        timestamp: new Date(payload.timestamp),
        seq: payload.seq,
        epoch: payload.epoch,
      });
      const timelines = new Map(state.timelines);
      timelines.set(
        key,
        settleTimeline(
          {
            tail: next.tail,
            head: next.head,
            epoch: payload.epoch,
            lastSeq: payload.seq,
            cursor: next.cursor ?? current.cursor,
            hasOlder: current.hasOlder,
            needsRefresh:
              current.needsRefresh || next.sideEffects.some((effect) => effect.type === "catch_up"),
          },
          state.descriptors.get(key),
        ),
      );
      return { timelines };
    });
  },
  replaceTimeline(serverId, payload) {
    const provider = payload.provider;
    if (!provider) {
      return;
    }
    set((state) => {
      const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
      const existing = state.timelines.get(key);
      const current = existing ?? EMPTY_TIMELINE;
      // Normalize optional wire metadata at the child timeline boundary. Legacy
      // notices are complete singleton items; history always comes from a projected host.
      const entries = payload.rows.map((row) => ({
        ...row,
        provider,
        seqStart: row.seqStart ?? row.seq,
        seqEnd: row.seqEnd ?? row.seq,
      }));
      const result = processTimelineResponse({
        payload: {
          ...payload,
          agentId: payload.subagentId,
          projection: "projected",
          startCursor:
            payload.startCursor ??
            (entries.length ? { seq: Math.min(...entries.map((entry) => entry.seqStart)) } : null),
          endCursor:
            payload.endCursor ??
            (entries.length ? { seq: Math.max(...entries.map((entry) => entry.seqEnd)) } : null),
          entries,
        },
        currentTail: current.tail,
        currentHead: current.head,
        currentCursor: current.cursor,
        isInitializing: current.cursor === undefined,
        hasActiveInitDeferred: current.cursor === undefined,
        initRequestDirection: "tail",
        sendingClientMessageIds: [],
      });
      const timelines = new Map(state.timelines);
      timelines.set(
        key,
        settleTimeline(
          {
            tail: result.tail,
            head: result.head,
            epoch: payload.epoch,
            lastSeq:
              payload.reset || current.epoch !== payload.epoch
                ? (result.cursor?.endSeq ?? 0)
                : Math.max(current.lastSeq, result.cursor?.endSeq ?? 0),
            cursor: result.cursor ?? undefined,
            hasOlder:
              result.older === "unchanged" ? current.hasOlder : result.older === "available",
            needsRefresh:
              result.sideEffects.some((effect) => effect.type === "catch_up") &&
              (payload.hasNewer || current.lastSeq > (result.cursor?.endSeq ?? 0)),
          },
          state.descriptors.get(key),
        ),
      );
      return { timelines };
    });
  },
}));

/** Owns child history bootstrap and recovery while a pane observes the child. */
export function observeProviderSubagentTimeline({
  client,
  serverId,
  parentAgentId,
  subagentId,
  limit,
  reportError,
}: {
  client: Pick<DaemonClient, "fetchProviderSubagentTimeline">;
  serverId: string;
  parentAgentId: string;
  subagentId: string;
  limit: number;
  reportError: (error: unknown) => void;
}): () => void {
  const key = providerSubagentKey(serverId, parentAgentId, subagentId);
  let active = true;
  let fetching = false;
  const refresh = async () => {
    if (!active || fetching) return;
    fetching = true;
    let succeeded = false;
    try {
      const payload = await client.fetchProviderSubagentTimeline(parentAgentId, subagentId, {
        direction: "tail",
        limit,
      });
      if (active) useProviderSubagentStore.getState().replaceTimeline(serverId, payload);
      succeeded = true;
    } catch (error) {
      // A later stream update or reopening the pane retries a disconnected read.
      if (!(error instanceof DaemonConnectionError)) throw error;
    } finally {
      fetching = false;
      if (
        succeeded &&
        active &&
        useProviderSubagentStore.getState().timelines.get(key)?.needsRefresh
      )
        requestRefresh();
    }
  };
  const requestRefresh = () => {
    void refresh().catch(reportError);
  };
  const unsubscribe = useProviderSubagentStore.subscribe((state) => {
    if (state.timelines.get(key)?.needsRefresh) requestRefresh();
  });
  requestRefresh();
  return () => {
    active = false;
    unsubscribe();
  };
}
