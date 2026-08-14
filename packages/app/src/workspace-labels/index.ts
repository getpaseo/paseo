import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  workspaceLabelKey,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { useMemo } from "react";
import { create } from "zustand";
import { HostWorkspaceLabelReplica } from "./internal/host-replica";
import { mergeWorkspaceLabelCatalogs } from "./internal/merge";
import { WorkspaceLabelManagerModel, WorkspaceLabelPickerModel } from "./internal/workflow-model";
import { i18n } from "@/i18n/i18next";

export {
  buildWorkspaceLabelPicker,
  shouldCloseWorkspaceLabelPicker,
} from "./internal/picker-model";
export { mergeWorkspaceLabelCatalogs } from "./internal/merge";
export type {
  WorkspaceLabelManagerHost,
  WorkspaceLabelManagerSnapshot,
  WorkspaceLabelPickerModelSnapshot,
} from "./internal/workflow-model";

export function createWorkspaceLabelPickerModel(
  dependencies: ConstructorParameters<typeof WorkspaceLabelPickerModel>[0],
): WorkspaceLabelPickerModel {
  return new WorkspaceLabelPickerModel(dependencies);
}

export function createWorkspaceLabelManagerModel(
  dependencies: ConstructorParameters<typeof WorkspaceLabelManagerModel>[0],
): WorkspaceLabelManagerModel {
  return new WorkspaceLabelManagerModel(dependencies);
}

export interface WorkspaceLabelHostSnapshot {
  serverId: string;
  labels: WorkspaceLabelDefinition[];
  status: "offline" | "online" | "unsupported";
  error: string | null;
}

interface WorkspaceLabelState {
  hosts: Record<string, WorkspaceLabelHostSnapshot>;
  setHost: (host: WorkspaceLabelHostSnapshot) => void;
}

export const useWorkspaceLabels = create<WorkspaceLabelState>((set) => ({
  hosts: {},
  setHost: (host) => set((state) => ({ hosts: { ...state.hosts, [host.serverId]: host } })),
}));

export interface WorkspaceLabelProjection {
  hosts: readonly WorkspaceLabelHostSnapshot[];
  labels: readonly WorkspaceLabelDefinition[];
  targetHost: WorkspaceLabelHostSnapshot | undefined;
}

export function projectWorkspaceLabels(
  hostsById: Readonly<Record<string, WorkspaceLabelHostSnapshot>>,
  targetServerId?: string,
): WorkspaceLabelProjection {
  const hosts = Object.values(hostsById);
  const catalogs = hosts
    .filter((host) => host.status === "online")
    .map((host) => ({ serverId: host.serverId, labels: host.labels }));
  return {
    hosts,
    labels: mergeWorkspaceLabelCatalogs({ catalogs, targetServerId }),
    targetHost: targetServerId ? hostsById[targetServerId] : undefined,
  };
}

/** Reactive cross-host projection. Consumers do not reconstruct replica eligibility or precedence. */
export function useWorkspaceLabelProjection(targetServerId?: string): WorkspaceLabelProjection {
  const hosts = useWorkspaceLabels((state) => state.hosts);
  return useMemo(() => projectWorkspaceLabels(hosts, targetServerId), [hosts, targetServerId]);
}

/**
 * The definitions behind the label names a workspace carries, in assignment order.
 *
 * Resolved against the workspace's own host and nothing else. The cross-host projection is for
 * surfaces that span hosts — a filter page, a manager — and it would answer here too, but two
 * hosts are free to give the same name different colors, and a merged catalog settles that by
 * precedence and then alphabetical serverId. A row that drew its label in a color its host never
 * assigned would be lying about the one thing the color is for.
 *
 * A workspace stores names; the color lives in that host's catalog, so a name the catalog does
 * not know is dropped rather than drawn in an invented color. The catalog survives the host going
 * offline, so this only drops names while a host's first list is still in flight.
 */
export function useWorkspaceLabelDefinitions(
  serverId: string,
  names: readonly string[] | undefined,
): readonly WorkspaceLabelDefinition[] {
  const hostsById = useWorkspaceLabels((state) => state.hosts);
  return useMemo(
    () => selectWorkspaceLabelDefinitions({ hostsById, serverId, names }),
    [hostsById, names, serverId],
  );
}

export function selectWorkspaceLabelDefinitions(input: {
  hostsById: Readonly<Record<string, WorkspaceLabelHostSnapshot>>;
  serverId: string;
  names: readonly string[] | undefined;
}): readonly WorkspaceLabelDefinition[] {
  const { hostsById, serverId, names } = input;
  if (!names || names.length === 0) return EMPTY_LABEL_DEFINITIONS;
  const catalog = hostsById[serverId]?.labels ?? [];
  const byKey = new Map(catalog.map((label) => [workspaceLabelKey(label.name), label]));
  return names.flatMap((name) => {
    const definition = byKey.get(workspaceLabelKey(name));
    return definition ? [definition] : [];
  });
}

const EMPTY_LABEL_DEFINITIONS: readonly WorkspaceLabelDefinition[] = [];

interface HostConnection {
  client: DaemonClient;
  replica: HostWorkspaceLabelReplica;
  unsubscribe: () => void;
}

class WorkspaceLabelsController {
  private readonly replicas = new Map<string, HostWorkspaceLabelReplica>();
  private readonly connections = new Map<string, HostConnection>();

  async connect(input: {
    serverId: string;
    client: DaemonClient;
    supportsWorkspaceLabels: boolean;
  }): Promise<void> {
    this.disconnect(input.serverId);
    const replica = this.replicas.get(input.serverId) ?? new HostWorkspaceLabelReplica();
    this.replicas.set(input.serverId, replica);
    if (!input.supportsWorkspaceLabels) {
      this.publish(input.serverId, replica, "unsupported", null);
      return;
    }

    const unsubscribe = input.client.on("workspace.label.update", (message) => {
      if (!replica.applyUpdate(message)) {
        void this.refresh(input.serverId).catch(() => undefined);
        return;
      }
      this.publish(input.serverId, replica, "online", null);
    });
    this.connections.set(input.serverId, { client: input.client, replica, unsubscribe });
    await this.refresh(input.serverId);
  }

  disconnect(serverId: string): void {
    this.connections.get(serverId)?.unsubscribe();
    this.connections.delete(serverId);
    const replica = this.replicas.get(serverId);
    if (replica) this.publish(serverId, replica, "offline", null);
  }

  async setAssignment(input: {
    serverId: string;
    workspaceId: string;
    label: WorkspaceLabelDefinition;
    assigned: boolean;
  }) {
    return this.mutate(input.serverId, (client) => client.setWorkspaceLabel(input));
  }

  async rename(input: { serverId: string; name: string; newName: string }) {
    return this.mutate(input.serverId, (client) => client.renameWorkspaceLabel(input));
  }

  async recolor(input: {
    serverId: string;
    name: string;
    color: WorkspaceLabelDefinition["color"];
  }) {
    return this.mutate(input.serverId, (client) => client.recolorWorkspaceLabel(input));
  }

  async delete(input: { serverId: string; name: string }) {
    return this.mutate(input.serverId, (client) => client.deleteWorkspaceLabel(input));
  }

  async inspectDelete(input: { serverId: string; name: string }) {
    return this.mutate(input.serverId, (client) => client.inspectWorkspaceLabelDelete(input));
  }

  private async refresh(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;
    try {
      const payload = await connection.client.listWorkspaceLabels({
        subscriptionId: `workspace-labels:${serverId}`,
        sync: connection.replica.snapshot().cursor,
      });
      connection.replica.applyList(payload);
      this.publish(serverId, connection.replica, "online", null);
    } catch (error) {
      this.publish(
        serverId,
        connection.replica,
        "online",
        error instanceof Error ? error.message : i18n.t("workspaceLabels.errors.load"),
      );
      throw error;
    }
  }

  private async mutate<T>(serverId: string, operation: (client: DaemonClient) => Promise<T>) {
    const connection = this.connections.get(serverId);
    if (!connection) throw new Error(i18n.t("workspaceLabels.manage.offline"));
    try {
      return await operation(connection.client);
    } catch (error) {
      await this.refresh(serverId).catch(() => undefined);
      throw error;
    }
  }

  private publish(
    serverId: string,
    replica: HostWorkspaceLabelReplica,
    status: WorkspaceLabelHostSnapshot["status"],
    error: string | null,
  ): void {
    useWorkspaceLabels.getState().setHost({
      serverId,
      labels: replica.snapshot().labels,
      status,
      error,
    });
  }
}

export const workspaceLabels = new WorkspaceLabelsController();
