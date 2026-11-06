import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/shim/with-selector";
import type { AgentRef, WorkspaceRef, ProjectRef, TerminalRef } from "../refs.js";
import type {
  PluginAgentSnapshot,
  PluginWorkspaceSnapshot,
  PluginProjectSnapshot,
  PluginTerminalSnapshot,
} from "../contracts.js";
import { createCollectionQuery, type Query, type Group } from "./query.js";
import { shallowEqual } from "./shallow.js";

export interface PluginClientStateSource {
  subscribe(listener: () => void): () => void;
  getWorkspace(id: string | WorkspaceRef): PluginWorkspaceSnapshot | null;
  getAgent(id: string | AgentRef): PluginAgentSnapshot | null;
  getProject(ref: ProjectRef): PluginProjectSnapshot | null;
  getTerminal(ref: TerminalRef): PluginTerminalSnapshot | null;
  getSnapshot(): PluginClientSnapshot;
}

export interface PluginClientSnapshot {
  readonly workspaces: readonly PluginWorkspaceSnapshot[];
  readonly agents: readonly PluginAgentSnapshot[];
  readonly projects: readonly PluginProjectSnapshot[];
  readonly terminals: readonly PluginTerminalSnapshot[];
}

const PluginClientStateContext = createContext<PluginClientStateSource | null>(null);

export function usePluginClientStateSource(): PluginClientStateSource | null {
  return useContext(PluginClientStateContext);
}

/** Shared selection semantics for host surfaces and plugin entities. */
export function usePaseoSelector<Entity, Selection>(
  source: { subscribe(listener: () => void): () => void },
  read: () => Entity,
  selector: (entity: Entity) => Selection,
  equals: (left: Selection, right: Selection) => boolean = shallowEqual,
): Selection {
  return useSyncExternalStoreWithSelector(source.subscribe, read, read, selector, equals);
}

type Equality<T> = { equals(left: T, right: T): boolean }["equals"];

function createEntityHook<Ref, Entity>(
  read: (source: PluginClientStateSource, ref: Ref) => Entity | null,
) {
  function useEntity(
    ref: Ref,
    selector?: undefined,
    equals?: Equality<Entity | null>,
  ): Entity | null;
  function useEntity<Selection>(
    ref: Ref,
    selector: (entity: Entity) => Selection,
    equals?: Equality<Selection | null>,
  ): Selection | null;
  function useEntity<Selection>(
    ref: Ref,
    selector?: (entity: Entity) => Selection,
    equals?: Equality<Entity | Selection | null>,
  ): Entity | Selection | null {
    const source = usePluginClientStateSource();
    if (!source) throw new Error("Plugin state hooks must run inside a plugin host");
    function select(entity: Entity | null): Entity | Selection | null {
      return entity !== null && selector ? selector(entity) : entity;
    }
    const equality = equals ?? (selector ? shallowEqual : Object.is);
    return usePaseoSelector(source, () => read(source, ref), select, equality);
  }
  return useEntity;
}

// COMPAT(plugin-entity-id): string ids accepted since 0.16; remove after 2027-03.
export const useWorkspace = createEntityHook((source, ref: WorkspaceRef | string) =>
  source.getWorkspace(ref),
);
// COMPAT(plugin-entity-id): string ids accepted since 0.16; remove after 2027-03.
export const useAgent = createEntityHook((source, ref: AgentRef | string) => source.getAgent(ref));
export const useProject = createEntityHook((source, ref: ProjectRef) => source.getProject(ref));
export const useTerminal = createEntityHook((source, ref: TerminalRef) => source.getTerminal(ref));

function createCollectionHook<Snapshot extends { readonly ref: unknown; readonly hostId: string }>(
  read: (source: PluginClientStateSource) => readonly Snapshot[],
) {
  function useCollection(
    query: Query<Snapshot> & { groupBy: NonNullable<Query<Snapshot>["groupBy"]> },
  ): readonly Group<Snapshot["ref"]>[];
  function useCollection(
    query?: Query<Snapshot> & { groupBy?: undefined },
  ): readonly Snapshot["ref"][];
  function useCollection(
    query: Query<Snapshot>,
  ): readonly Snapshot["ref"][] | readonly Group<Snapshot["ref"]>[];
  function useCollection(
    query: Query<Snapshot> = {},
  ): readonly Snapshot["ref"][] | readonly Group<Snapshot["ref"]>[] {
    const source = usePluginClientStateSource();
    if (!source) throw new Error("Plugin state hooks must run inside a plugin host");
    const project = useMemo(() => createCollectionQuery<Snapshot>(), []);
    return usePaseoSelector(
      source,
      () => read(source),
      (snapshots) => project(snapshots, query),
      Object.is,
    );
  }
  return useCollection;
}

export const useWorkspaces = createCollectionHook((source) => source.getSnapshot().workspaces);
export const useAgents = createCollectionHook((source) => source.getSnapshot().agents);
export const useProjects = createCollectionHook((source) => source.getSnapshot().projects);
export const useTerminals = createCollectionHook((source) => source.getSnapshot().terminals);

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
