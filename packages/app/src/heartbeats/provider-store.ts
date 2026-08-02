import type { ProviderHeartbeatDescriptorPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { create } from "zustand";

export function providerHeartbeatKey(
  serverId: string,
  parentAgentId: string,
  taskId: string,
): string {
  return `${serverId}\0${parentAgentId}\0${taskId}`;
}

function parentPrefix(serverId: string, parentAgentId: string): string {
  return `${serverId}\0${parentAgentId}\0`;
}

interface ProviderHeartbeatState {
  heartbeats: Map<string, ProviderHeartbeatDescriptorPayload>;
  replaceList(
    serverId: string,
    parentAgentId: string,
    heartbeats: ProviderHeartbeatDescriptorPayload[],
  ): void;
  applyUpdate(
    serverId: string,
    payload: { parentAgentId: string; heartbeats: ProviderHeartbeatDescriptorPayload[] },
  ): void;
}

export const useProviderHeartbeatStore = create<ProviderHeartbeatState>((set) => ({
  heartbeats: new Map(),
  replaceList(serverId, parentAgentId, heartbeats) {
    set((state) => {
      const next = new Map(state.heartbeats);
      const prefix = parentPrefix(serverId, parentAgentId);
      for (const key of next.keys()) {
        if (key.startsWith(prefix)) {
          next.delete(key);
        }
      }
      for (const heartbeat of heartbeats) {
        next.set(providerHeartbeatKey(serverId, parentAgentId, heartbeat.taskId), heartbeat);
      }
      return { heartbeats: next };
    });
  },
  applyUpdate(serverId, payload) {
    useProviderHeartbeatStore
      .getState()
      .replaceList(serverId, payload.parentAgentId, payload.heartbeats);
  },
}));

type ProviderHeartbeatListClient = Pick<DaemonClient, "listProviderHeartbeats">;

const pendingListRequests = new WeakMap<ProviderHeartbeatListClient, Map<string, Promise<void>>>();

export function refreshProviderHeartbeats(
  client: ProviderHeartbeatListClient,
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
    .listProviderHeartbeats(parentAgentId)
    .then((payload) => {
      useProviderHeartbeatStore.getState().replaceList(serverId, parentAgentId, payload.heartbeats);
      return undefined;
    })
    .finally(() => {
      clientRequests?.delete(requestKey);
    });
  clientRequests.set(requestKey, request);
  return request;
}

export function selectProviderHeartbeatsForParent(
  heartbeats: Map<string, ProviderHeartbeatDescriptorPayload>,
  serverId: string,
  parentAgentId: string,
): ProviderHeartbeatDescriptorPayload[] {
  const prefix = parentPrefix(serverId, parentAgentId);
  const rows: ProviderHeartbeatDescriptorPayload[] = [];
  for (const [key, heartbeat] of heartbeats) {
    if (!key.startsWith(prefix)) continue;
    rows.push(heartbeat);
  }
  rows.sort((left, right) => left.taskId.localeCompare(right.taskId));
  return rows;
}
