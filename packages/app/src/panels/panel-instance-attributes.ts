import { useCallback, useEffect, useSyncExternalStore } from "react";
import { usePaneContext } from "@/panels/pane-context";

export interface PanelInstanceIdentity {
  serverId: string;
  workspaceId: string;
  tabId: string;
}

export interface PanelInstanceAttributes {
  modified: boolean;
}

const DEFAULT_ATTRIBUTES: PanelInstanceAttributes = { modified: false };
const attributesByPanel = new Map<string, PanelInstanceAttributes>();
const listenersByPanel = new Map<string, Set<() => void>>();

export function buildPanelInstanceKey(identity: PanelInstanceIdentity): string {
  return `${identity.serverId}:${identity.workspaceId}:${identity.tabId}`;
}

export function getPanelInstanceAttributes(
  identity: PanelInstanceIdentity,
): PanelInstanceAttributes {
  return attributesByPanel.get(buildPanelInstanceKey(identity)) ?? DEFAULT_ATTRIBUTES;
}

export function setPanelInstanceAttributes(
  identity: PanelInstanceIdentity,
  attributes: PanelInstanceAttributes,
): void {
  const key = buildPanelInstanceKey(identity);
  const previous = attributesByPanel.get(key) ?? DEFAULT_ATTRIBUTES;
  if (previous.modified === attributes.modified) return;
  if (attributes.modified) attributesByPanel.set(key, attributes);
  else attributesByPanel.delete(key);
  for (const listener of listenersByPanel.get(key) ?? []) listener();
}

export function subscribePanelInstanceAttributes(
  identity: PanelInstanceIdentity,
  listener: () => void,
): () => void {
  const key = buildPanelInstanceKey(identity);
  const listeners = listenersByPanel.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByPanel.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByPanel.delete(key);
  };
}

export function usePanelInstanceAttributes({
  serverId,
  workspaceId,
  tabId,
}: PanelInstanceIdentity): PanelInstanceAttributes {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribePanelInstanceAttributes({ serverId, workspaceId, tabId }, listener),
    [serverId, tabId, workspaceId],
  );
  const getSnapshot = useCallback(
    () => getPanelInstanceAttributes({ serverId, workspaceId, tabId }),
    [serverId, tabId, workspaceId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePublishPanelInstanceAttributes(attributes: PanelInstanceAttributes): void {
  const { serverId, workspaceId, tabId } = usePaneContext();
  const modified = attributes.modified;
  useEffect(() => {
    const identity = { serverId, workspaceId, tabId };
    setPanelInstanceAttributes(identity, { modified });
    return () => setPanelInstanceAttributes(identity, DEFAULT_ATTRIBUTES);
  }, [modified, serverId, tabId, workspaceId]);
}
