export { REPLICA_ROW_STORE_SCHEMA_VERSION, REPLICA_SINGLETON_ROW_ID } from "./row-store-schema";

export type ReplicaRowKind = "agent" | "workspace" | "project" | "timeline" | "checkpoint";

export interface ReplicaRowKey {
  serverId: string;
  kind: ReplicaRowKind;
  id: string;
}

export interface ReplicaRow extends ReplicaRowKey {
  payload: string;
}

export interface ReplicaRowChanges {
  upserts: ReplicaRow[];
  deletes: ReplicaRowKey[];
}

export interface ReplicaRowApplyOptions {
  // Hosts whose whole directory these changes replace. Passing the option, even empty, asks a
  // shared store to reject directory changes for hosts another connection rewrote since.
  directoryBaselines?: ReadonlySet<string>;
}

export interface ReplicaHostRows {
  serverId: string;
  rows: ReplicaRow[];
}

export interface ReplicaRowStore {
  open(): Promise<void>;
  read(
    serverId: string,
    kinds: readonly ReplicaRowKind[],
    ids?: readonly string[],
  ): Promise<ReplicaRow[]>;
  readAll(): Promise<ReplicaHostRows[]>;
  // Shared stores can reject directory deltas that no longer match their baseline.
  // Return the accepted changes when they differ from the requested changes.
  apply(
    changes: ReplicaRowChanges,
    options?: ReplicaRowApplyOptions,
  ): Promise<ReplicaRowChanges | void>;
  deleteHost(serverId: string): Promise<void>;
  renameHost(oldServerId: string, newServerId: string): Promise<void>;
  clear(): Promise<void>;
}
