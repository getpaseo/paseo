import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { usePaneContext } from "@/panels/pane-context";

export interface PanelInstanceIdentity {
  serverId: string;
  workspaceId: string;
  tabId: string;
}

export interface PanelInstanceAttributes {
  modified: boolean;
  suspendPendingSave?: () => () => void;
}

const DEFAULT_ATTRIBUTES: PanelInstanceAttributes = { modified: false };
const attributesByPanel = new Map<string, PanelInstanceAttributes>();
const listenersByPanel = new Map<string, Set<() => void>>();
const allListeners = new Set<() => void>();
let attributesRevision = 0;

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
  if (
    previous.modified === attributes.modified &&
    previous.suspendPendingSave === attributes.suspendPendingSave
  ) {
    return;
  }
  if (attributes.modified) attributesByPanel.set(key, attributes);
  else attributesByPanel.delete(key);
  attributesRevision += 1;
  for (const listener of listenersByPanel.get(key) ?? []) listener();
  for (const listener of allListeners) listener();
}

export function useModifiedPanelTabIds(input: {
  serverId: string;
  workspaceId: string;
  tabIds: string[];
}): Set<string> {
  const revision = useSyncExternalStore(
    useCallback((listener: () => void) => {
      allListeners.add(listener);
      return () => allListeners.delete(listener);
    }, []),
    () => attributesRevision,
    () => attributesRevision,
  );
  return useMemo(() => {
    void revision;
    return new Set(
      input.tabIds.filter(
        (tabId) =>
          getPanelInstanceAttributes({
            serverId: input.serverId,
            workspaceId: input.workspaceId,
            tabId,
          }).modified,
      ),
    );
  }, [input.serverId, input.tabIds, input.workspaceId, revision]);
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
  const suspendPendingSave = attributes.suspendPendingSave;
  useEffect(() => {
    const identity = { serverId, workspaceId, tabId };
    setPanelInstanceAttributes(identity, { modified, suspendPendingSave });
    return () => setPanelInstanceAttributes(identity, DEFAULT_ATTRIBUTES);
  }, [modified, serverId, suspendPendingSave, tabId, workspaceId]);
}
