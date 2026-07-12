import type {
  AgentStreamEventPayload,
  ProviderSubagentDescriptorPayload,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { create } from "zustand";
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
  rows: Map<number, ProviderSubagentTimelineRow>;
}

interface ProviderSubagentState {
  descriptors: Map<string, ProviderSubagentDescriptorPayload>;
  timelines: Map<string, ProviderSubagentTimelineState>;
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

const EMPTY_TIMELINE: ProviderSubagentTimelineState = {
  tail: [],
  head: [],
  epoch: null,
  lastSeq: 0,
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
    rows,
  };
}

export const useProviderSubagentStore = create<ProviderSubagentState>((set) => ({
  descriptors: new Map(),
  timelines: new Map(),
  replaceList(serverId, parentAgentId, subagents) {
    set((state) => {
      const prefix = parentPrefix(serverId, parentAgentId);
      const descriptors = new Map(
        [...state.descriptors].filter(([key]) => !key.startsWith(prefix)),
      );
      for (const subagent of subagents) {
        descriptors.set(providerSubagentKey(serverId, parentAgentId, subagent.id), subagent);
      }
      const retainedKeys = new Set(descriptors.keys());
      const timelines = new Map(
        [...state.timelines].filter(([key]) => !key.startsWith(prefix) || retainedKeys.has(key)),
      );
      return { descriptors, timelines };
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
        descriptors.set(key, payload.subagent);
        let timelines = state.timelines;
        const current = state.timelines.get(key);
        if (current) {
          timelines = new Map(state.timelines);
          timelines.set(key, buildTimelineState(current.rows, current.epoch, payload.subagent));
        }
        return { descriptors, timelines };
      }
      if (payload.kind === "remove") {
        const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
        const descriptors = new Map(state.descriptors);
        const timelines = new Map(state.timelines);
        descriptors.delete(key);
        timelines.delete(key);
        return { descriptors, timelines };
      }
      const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
      const existing = state.timelines.get(key) ?? EMPTY_TIMELINE;
      const current = existing.epoch === payload.epoch ? existing : EMPTY_TIMELINE;
      if (current.epoch === payload.epoch && payload.seq <= current.lastSeq) {
        return state;
      }
      const rows = new Map(current.rows);
      rows.set(payload.seq, {
        provider: payload.provider,
        item: payload.item,
        timestamp: payload.timestamp,
      });
      const next = applyStreamEvent({
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
      const rows = new Map(
        !payload.reset && existing?.epoch === payload.epoch ? existing.rows : [],
      );
      for (const row of payload.rows) {
        rows.set(row.seq, { provider, item: row.item, timestamp: row.timestamp });
      }
      const descriptor = state.descriptors.get(key);
      const timelines = new Map(state.timelines);
      timelines.set(key, buildTimelineState(rows, payload.epoch, descriptor));
      return { timelines };
    });
  },
}));
