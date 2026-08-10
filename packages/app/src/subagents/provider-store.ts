import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  AgentStreamEventPayload,
  ProviderSubagentDescriptorPayload,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { create, type StateCreator } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { applyStreamEvent } from "@/types/stream";
import type { StreamItem } from "@/types/stream";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

type ProviderSubagentTimelineItem = Extract<
  Extract<SessionOutboundMessage, { type: "agent.provider_subagents.update" }>["payload"],
  { kind: "timeline" }
>["item"];

interface ProviderSubagentTimelineRow {
  provider: ProviderSubagentDescriptorPayload["provider"];
  item: ProviderSubagentTimelineItem;
  timestamp: string;
}

export interface ProviderSubagentTimelineState {
  tail: StreamItem[];
  head: StreamItem[];
  epoch: string | null;
  lastSeq: number;
  hasOlder: boolean;
  rows: Map<number, ProviderSubagentTimelineRow>;
}

export interface ProviderSubagentState {
  descriptors: Map<string, ProviderSubagentDescriptorPayload>;
  timelines: Map<string, ProviderSubagentTimelineState>;
  hiddenFromTrack: Set<string>;
  hideFinishedForParent(serverId: string, parentAgentId: string): void;
  showHiddenForParent(serverId: string, parentAgentId: string): void;
  replaceList(
    serverId: string,
    parentAgentId: string,
    subagents: ProviderSubagentDescriptorPayload[],
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

type ProviderSubagentListClient = Pick<DaemonClient, "listProviderSubagents">;

const pendingListRequests = new WeakMap<ProviderSubagentListClient, Map<string, Promise<void>>>();

export function refreshProviderSubagents(
  client: ProviderSubagentListClient,
  serverId: string,
  parentAgentId: string,
): Promise<void> {
  const requestKey = `${serverId}\0${parentAgentId}`;
  let clientRequests = pendingListRequests.get(client);
  if (!clientRequests) {
    clientRequests = new Map();
    pendingListRequests.set(client, clientRequests);
  }
  const pending = clientRequests.get(requestKey);
  if (pending) return pending;

  const request = client
    .listProviderSubagents(parentAgentId)
    .then((payload) => {
      useProviderSubagentStore.getState().replaceList(serverId, parentAgentId, payload.subagents);
      return undefined;
    })
    .finally(() => {
      clientRequests?.delete(requestKey);
    });
  clientRequests.set(requestKey, request);
  return request;
}

function parentPrefix(serverId: string, parentAgentId: string): string {
  return `${serverId}\0${parentAgentId}\0`;
}

export function hasHiddenProviderSubagentsForParent(
  hiddenFromTrack: ReadonlySet<string>,
  serverId: string,
  parentAgentId: string,
): boolean {
  const prefix = parentPrefix(serverId, parentAgentId);
  for (const key of hiddenFromTrack) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function serializeProviderSubagentVisibility(state: ProviderSubagentState): {
  hiddenFromTrack: string[];
} {
  return { hiddenFromTrack: [...state.hiddenFromTrack] };
}

function mergeProviderSubagentVisibility(
  persistedState: unknown,
  currentState: ProviderSubagentState,
  revealedKeys: ReadonlySet<string>,
): ProviderSubagentState {
  if (!persistedState || typeof persistedState !== "object" || Array.isArray(persistedState)) {
    return currentState;
  }
  const hiddenFromTrack = Object.hasOwn(persistedState, "hiddenFromTrack")
    ? Reflect.get(persistedState, "hiddenFromTrack")
    : undefined;
  if (!Array.isArray(hiddenFromTrack)) return currentState;
  const mergedHiddenFromTrack = new Set(
    hiddenFromTrack.filter((key): key is string => typeof key === "string"),
  );
  for (const key of revealedKeys) mergedHiddenFromTrack.delete(key);
  for (const key of currentState.hiddenFromTrack) mergedHiddenFromTrack.add(key);
  for (const [key, descriptor] of currentState.descriptors) {
    if (descriptor.status === "running") mergedHiddenFromTrack.delete(key);
  }
  return { ...currentState, hiddenFromTrack: mergedHiddenFromTrack };
}

const EMPTY_TIMELINE: ProviderSubagentTimelineState = {
  tail: [],
  head: [],
  epoch: null,
  lastSeq: 0,
  hasOlder: false,
  rows: new Map(),
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

function buildTimelineState(
  rows: ProviderSubagentTimelineState["rows"],
  epoch: string | null,
  descriptor?: ProviderSubagentDescriptorPayload,
  hasOlder = false,
): ProviderSubagentTimelineState {
  let timeline = { tail: [] as StreamItem[], head: [] as StreamItem[] };
  for (const [, row] of [...rows].sort(([left], [right]) => left - right)) {
    timeline = applyStreamEvent({
      ...timeline,
      event: { type: "timeline", provider: row.provider, item: row.item },
      timestamp: new Date(row.timestamp),
    });
  }
  const terminalEvent = descriptor ? providerSubagentTerminalEvent(descriptor) : null;
  if (terminalEvent && descriptor) {
    timeline = applyStreamEvent({
      ...timeline,
      event: terminalEvent,
      timestamp: new Date(descriptor.updatedAt),
    });
  }
  return {
    ...timeline,
    epoch,
    lastSeq: rows.size ? Math.max(...rows.keys()) : 0,
    hasOlder,
    rows,
  };
}

function buildTimelineResponseRows(
  existing: ProviderSubagentTimelineState | undefined,
  payload: Extract<
    SessionOutboundMessage,
    { type: "agent.provider_subagents.timeline.get.response" }
  >["payload"],
  provider: ProviderSubagentDescriptorPayload["provider"],
): ProviderSubagentTimelineState["rows"] {
  const rows = new Map<number, ProviderSubagentTimelineRow>();
  for (const row of payload.rows) {
    rows.set(row.seq, { provider, item: row.item, timestamp: row.timestamp });
  }
  if (payload.reset || existing?.epoch !== payload.epoch) {
    return rows;
  }
  if (payload.direction !== "tail") {
    return new Map([...existing.rows, ...rows]);
  }

  let nextSeq = payload.rows.length
    ? Math.max(...payload.rows.map((row) => row.seq)) + 1
    : payload.window.maxSeq + 1;
  for (const [seq, row] of [...existing.rows].sort(([left], [right]) => left - right)) {
    if (seq < nextSeq) continue;
    if (seq !== nextSeq) break;
    rows.set(seq, row);
    nextSeq += 1;
  }
  return rows;
}

const createProviderSubagentState: StateCreator<ProviderSubagentState> = (set) => ({
  descriptors: new Map(),
  timelines: new Map(),
  hiddenFromTrack: new Set(),
  hideFinishedForParent(serverId, parentAgentId) {
    set((state) => {
      const prefix = parentPrefix(serverId, parentAgentId);
      const hiddenFromTrack = new Set(state.hiddenFromTrack);
      for (const [key, subagent] of state.descriptors) {
        if (key.startsWith(prefix) && subagent.status !== "running") {
          hiddenFromTrack.add(key);
        }
      }
      return { hiddenFromTrack };
    });
  },
  showHiddenForParent(serverId, parentAgentId) {
    set((state) => {
      const prefix = parentPrefix(serverId, parentAgentId);
      const hiddenFromTrack = new Set(state.hiddenFromTrack);
      for (const key of hiddenFromTrack) {
        if (key.startsWith(prefix)) hiddenFromTrack.delete(key);
      }
      return { hiddenFromTrack };
    });
  },
  replaceList(serverId, parentAgentId, subagents) {
    set((state) => {
      const prefix = parentPrefix(serverId, parentAgentId);
      const descriptors = new Map(
        [...state.descriptors].filter(([key]) => !key.startsWith(prefix)),
      );
      const hiddenFromTrack = new Set(state.hiddenFromTrack);
      for (const subagent of subagents) {
        const key = providerSubagentKey(serverId, parentAgentId, subagent.id);
        descriptors.set(key, subagent);
        if (subagent.status === "running") {
          hiddenFromTrack.delete(key);
        }
      }
      const retainedKeys = new Set(descriptors.keys());
      const timelines = new Map(
        [...state.timelines].filter(([key]) => !key.startsWith(prefix) || retainedKeys.has(key)),
      );
      for (const subagent of subagents) {
        const key = providerSubagentKey(serverId, parentAgentId, subagent.id);
        const current = timelines.get(key);
        const previous = state.descriptors.get(key);
        if (current && previous?.status !== subagent.status) {
          timelines.set(
            key,
            buildTimelineState(current.rows, current.epoch, subagent, current.hasOlder),
          );
        }
      }
      return { descriptors, timelines, hiddenFromTrack };
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
          timelines.set(
            key,
            buildTimelineState(current.rows, current.epoch, payload.subagent, current.hasOlder),
          );
        }
        return { descriptors, timelines, hiddenFromTrack };
      }
      if (payload.kind === "remove") {
        const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
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
      const rows = new Map(current.rows);
      rows.set(payload.seq, {
        provider: payload.provider,
        item: payload.item,
        timestamp: payload.timestamp,
      });
      const descriptor = state.descriptors.get(key);
      const next =
        descriptor && descriptor.status !== "running"
          ? buildTimelineState(rows, payload.epoch, descriptor, current.hasOlder)
          : applyStreamEvent({
              tail: current.tail,
              head: current.head,
              event: { type: "timeline", provider: payload.provider, item: payload.item },
              timestamp: new Date(payload.timestamp),
            });
      const timelines = new Map(state.timelines);
      timelines.set(key, {
        ...next,
        epoch: payload.epoch,
        lastSeq: payload.seq,
        hasOlder: current.hasOlder,
        rows,
      });
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
      const rows = buildTimelineResponseRows(existing, payload, provider);
      const descriptor = state.descriptors.get(key);
      const timelines = new Map(state.timelines);
      timelines.set(key, buildTimelineState(rows, payload.epoch, descriptor, payload.hasOlder));
      return { timelines };
    });
  },
});

export function createProviderSubagentStore(storage: StateStorage = AsyncStorage) {
  let hydrationInProgress = false;
  const revealedKeys = new Set<string>();
  // AsyncStorage can resolve after startup replay or a user action. Remember visibility wins
  // observed during that window so the older snapshot cannot hide those children again.
  const observedStateCreator: StateCreator<ProviderSubagentState> = (set, get, store) => {
    const observedSet: typeof set = (...args) => {
      const previousState = get();
      const [nextState, replace] = args;
      if (replace === true) {
        set(
          nextState as
            | ProviderSubagentState
            | ((state: ProviderSubagentState) => ProviderSubagentState),
          true,
        );
      } else {
        set(nextState, false);
      }
      if (!hydrationInProgress) return;
      const currentState = get();
      for (const key of previousState.hiddenFromTrack) {
        if (!currentState.hiddenFromTrack.has(key)) revealedKeys.add(key);
      }
      for (const [key, descriptor] of currentState.descriptors) {
        if (descriptor.status === "running") revealedKeys.add(key);
      }
    };
    return createProviderSubagentState(observedSet, get, store);
  };
  return create<ProviderSubagentState>()(
    persist(observedStateCreator, {
      name: "provider-subagent-visibility",
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: serializeProviderSubagentVisibility,
      merge: (persistedState, currentState) =>
        mergeProviderSubagentVisibility(persistedState, currentState, revealedKeys),
      onRehydrateStorage: () => {
        hydrationInProgress = true;
        revealedKeys.clear();
        return () => {
          hydrationInProgress = false;
          revealedKeys.clear();
        };
      },
    }),
  );
}

export const useProviderSubagentStore = createProviderSubagentStore();
