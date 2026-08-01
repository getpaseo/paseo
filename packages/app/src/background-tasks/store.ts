import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { create } from "zustand";

export function backgroundTaskKey(serverId: string, parentAgentId: string, taskId: string): string {
  return `${serverId}\0${parentAgentId}\0${taskId}`;
}

function parentPrefix(serverId: string, parentAgentId: string): string {
  return `${serverId}\0${parentAgentId}\0`;
}

interface BackgroundTaskState {
  tasks: Map<string, BackgroundTaskDescriptorPayload>;
  replaceList(
    serverId: string,
    parentAgentId: string,
    tasks: BackgroundTaskDescriptorPayload[],
  ): void;
  applyUpdate(
    serverId: string,
    payload: { parentAgentId: string; tasks: BackgroundTaskDescriptorPayload[] },
  ): void;
}

export const useBackgroundTaskStore = create<BackgroundTaskState>((set) => ({
  tasks: new Map(),
  replaceList(serverId, parentAgentId, tasks) {
    set((state) => {
      const next = new Map(state.tasks);
      const prefix = parentPrefix(serverId, parentAgentId);
      for (const key of next.keys()) {
        if (key.startsWith(prefix)) {
          next.delete(key);
        }
      }
      for (const task of tasks) {
        next.set(backgroundTaskKey(serverId, parentAgentId, task.taskId), task);
      }
      return { tasks: next };
    });
  },
  applyUpdate(serverId, payload) {
    useBackgroundTaskStore.getState().replaceList(serverId, payload.parentAgentId, payload.tasks);
  },
}));

type BackgroundTaskListClient = Pick<DaemonClient, "listBackgroundTasks">;

const pendingListRequests = new WeakMap<BackgroundTaskListClient, Map<string, Promise<void>>>();

export function refreshBackgroundTasks(
  client: BackgroundTaskListClient,
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
    .listBackgroundTasks(parentAgentId)
    .then((payload) => {
      useBackgroundTaskStore.getState().replaceList(serverId, parentAgentId, payload.tasks);
      return undefined;
    })
    .finally(() => {
      clientRequests?.delete(requestKey);
    });
  clientRequests.set(requestKey, request);
  return request;
}

export function selectBackgroundTasksForParent(
  tasks: Map<string, BackgroundTaskDescriptorPayload>,
  serverId: string,
  parentAgentId: string,
): BackgroundTaskDescriptorPayload[] {
  const prefix = parentPrefix(serverId, parentAgentId);
  const rows: BackgroundTaskDescriptorPayload[] = [];
  for (const [key, task] of tasks) {
    if (!key.startsWith(prefix)) continue;
    rows.push(task);
  }
  rows.sort((left, right) => left.taskId.localeCompare(right.taskId));
  return rows;
}
