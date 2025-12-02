import { useSyncExternalStore } from "react";
import type { MessageEntry } from "@/contexts/session-context";
import type { StreamItem } from "@/types/stream";

export type SessionHeavyState = {
  messages: MessageEntry[];
  agentStreamState: Map<string, StreamItem[]>;
};

const EMPTY_MESSAGES: MessageEntry[] = [];
const EMPTY_AGENT_STREAM_STATE = new Map<string, StreamItem[]>();
const EMPTY_HEAVY_STATE: SessionHeavyState = {
  messages: EMPTY_MESSAGES,
  agentStreamState: EMPTY_AGENT_STREAM_STATE,
};

const heavyStateRegistry = new Map<string, SessionHeavyState>();
const heavyStateListeners = new Map<string, Set<() => void>>();
const directoryListeners = new Set<() => void>();

function getServerListeners(serverId: string): Set<() => void> {
  let listeners = heavyStateListeners.get(serverId);
  if (!listeners) {
    listeners = new Set();
    heavyStateListeners.set(serverId, listeners);
  }
  return listeners;
}

function notifyServer(serverId: string) {
  const listeners = heavyStateListeners.get(serverId);
  if (listeners) {
    for (const listener of listeners) {
      listener();
    }
  }
  for (const listener of directoryListeners) {
    listener();
  }
}

export function publishSessionHeavyState(serverId: string, state: SessionHeavyState) {
  heavyStateRegistry.set(serverId, state);
  notifyServer(serverId);
}

export function clearSessionHeavyState(serverId: string) {
  if (heavyStateRegistry.delete(serverId)) {
    notifyServer(serverId);
  }
}

export function getSessionHeavyState(serverId: string): SessionHeavyState | null {
  return heavyStateRegistry.get(serverId) ?? null;
}

function subscribeToServer(serverId: string | null, listener: () => void) {
  if (!serverId) {
    return () => {};
  }
  const listeners = getServerListeners(serverId);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function subscribeToDirectory(listener: () => void) {
  directoryListeners.add(listener);
  return () => {
    directoryListeners.delete(listener);
  };
}

function getServerSnapshot(serverId: string | null): SessionHeavyState {
  if (!serverId) {
    return EMPTY_HEAVY_STATE;
  }
  return heavyStateRegistry.get(serverId) ?? EMPTY_HEAVY_STATE;
}

function getDirectorySnapshot(): Map<string, SessionHeavyState> {
  return new Map(heavyStateRegistry.entries());
}

export function useSessionHeavyState(serverId: string | null): SessionHeavyState | null {
  const snapshot = useSyncExternalStore(
    (listener) => subscribeToServer(serverId, listener),
    () => getServerSnapshot(serverId),
    () => getServerSnapshot(serverId)
  );
  if (!serverId) {
    return null;
  }
  return snapshot;
}

export function useSessionHeavyDirectory(): Map<string, SessionHeavyState> {
  return useSyncExternalStore(subscribeToDirectory, getDirectorySnapshot, getDirectorySnapshot);
}

