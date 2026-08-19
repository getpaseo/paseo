import { createContext, useContext, type ReactNode } from "react";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/shim/with-selector";
import type { PluginAgentSnapshot, PluginWorkspaceSnapshot } from "./contracts.js";
import { shallowEqual } from "./shallow.js";

export interface PluginClientStateSource {
  subscribe(listener: () => void): () => void;
  getWorkspace(id: string): PluginWorkspaceSnapshot | null;
  getAgent(id: string): PluginAgentSnapshot | null;
}

const PluginClientStateContext = createContext<PluginClientStateSource | null>(null);

function usePluginEntity<Entity, Selection>(input: {
  id: string;
  read(source: PluginClientStateSource, id: string): Entity | null;
  selector(entity: Entity): Selection;
}): Selection | null {
  const source = useContext(PluginClientStateContext);
  if (!source) throw new Error("Plugin state hooks must run inside a workspace panel");
  return useSyncExternalStoreWithSelector(
    source.subscribe,
    () => input.read(source, input.id),
    () => input.read(source, input.id),
    (entity) => (entity ? input.selector(entity) : null),
    shallowEqual,
  );
}

export function useWorkspace<Selection>(
  workspaceId: string,
  selector: (workspace: PluginWorkspaceSnapshot) => Selection,
): Selection | null {
  return usePluginEntity({
    id: workspaceId,
    read: (source, id) => source.getWorkspace(id),
    selector,
  });
}

export function useAgent<Selection>(
  agentId: string,
  selector: (agent: PluginAgentSnapshot) => Selection,
): Selection | null {
  return usePluginEntity({
    id: agentId,
    read: (source, id) => source.getAgent(id),
    selector,
  });
}

export function PluginClientStateProvider({
  children,
  source,
}: {
  children: ReactNode;
  source: PluginClientStateSource;
}) {
  return (
    <PluginClientStateContext.Provider value={source}>{children}</PluginClientStateContext.Provider>
  );
}
