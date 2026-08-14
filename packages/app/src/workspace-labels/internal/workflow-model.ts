import {
  normalizeWorkspaceLabelName,
  workspaceLabelKey,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { buildWorkspaceLabelPickerRows, type WorkspaceLabelPickerRow } from "./picker-model";
import { i18n } from "@/i18n/i18next";

type Listener = () => void;

class ObservableModel {
  private readonly listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  protected publish(): void {
    for (const listener of this.listeners) listener();
  }
}

export interface WorkspaceLabelPickerModelSnapshot {
  rows: readonly WorkspaceLabelPickerRow[];
  error: string | null;
  online: boolean;
  pendingNames: string[];
}

/**
 * Assigning labels to one workspace: a row per catalog entry, and a toggle per row.
 *
 * Every press toggles and the menu stays open, so the model has no say in the surface's
 * lifetime — it holds no `close`, and picking a label is not an answer to a question. What it
 * does own is the one-in-flight-per-label rule, which is what keeps a double tap from firing two
 * opposite mutations at the same label.
 */
export class WorkspaceLabelPickerModel extends ObservableModel {
  private error: string | null = null;
  private online = false;
  private labels: readonly WorkspaceLabelDefinition[] = [];
  private assigned: readonly string[] = [];
  private readonly pending = new Map<string, Promise<boolean>>();
  private currentSnapshot: WorkspaceLabelPickerModelSnapshot;

  constructor(
    private readonly dependencies: {
      mutate: (input: { label: WorkspaceLabelDefinition; assigned: boolean }) => Promise<unknown>;
    },
  ) {
    super();
    this.currentSnapshot = this.buildSnapshot();
  }

  snapshot = (): WorkspaceLabelPickerModelSnapshot => this.currentSnapshot;

  sync(input: {
    labels: readonly WorkspaceLabelDefinition[];
    assigned: readonly string[];
    online: boolean;
  }): void {
    this.labels = input.labels;
    this.assigned = input.assigned;
    this.online = input.online;
    this.commit();
  }

  toggle(label: WorkspaceLabelDefinition, assigned: boolean): Promise<boolean> {
    const key = workspaceLabelKey(label.name);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    this.error = null;
    const operation = this.dependencies
      .mutate({ label, assigned })
      .then(() => true)
      .catch((cause: unknown) => {
        this.error = workspaceLabelErrorMessage(cause);
        return false;
      })
      .finally(() => {
        this.pending.delete(key);
        this.commit();
      });
    this.pending.set(key, operation);
    this.commit();
    return operation;
  }

  private commit(): void {
    this.currentSnapshot = this.buildSnapshot();
    this.publish();
  }

  private buildSnapshot(): WorkspaceLabelPickerModelSnapshot {
    return {
      rows: buildWorkspaceLabelPickerRows({ labels: this.labels, assigned: this.assigned }),
      error: this.error,
      online: this.online,
      pendingNames: [...this.pending.keys()],
    };
  }
}

export interface WorkspaceLabelManagerHost {
  serverId: string;
  label: string;
  status: "offline" | "online" | "unsupported";
  labels: readonly WorkspaceLabelDefinition[];
  error?: string | null;
}

export interface WorkspaceLabelManagerSnapshot {
  hosts: readonly WorkspaceLabelManagerHost[];
  serverId: string;
  selectedName: string | null;
  draftName: string;
  query: string;
  error: string | null;
  pending: boolean;
  host: WorkspaceLabelManagerHost | null;
  labels: WorkspaceLabelDefinition[];
  selected: WorkspaceLabelDefinition | null;
}

export class WorkspaceLabelManagerModel extends ObservableModel {
  private hosts: readonly WorkspaceLabelManagerHost[] = [];
  private serverId = "";
  private selectedName: string | null = null;
  private draftName = "";
  private query = "";
  private error: string | null = null;
  private operation: Promise<void> | null = null;
  private currentSnapshot: WorkspaceLabelManagerSnapshot;

  constructor(
    private readonly dependencies: {
      rename: (input: { serverId: string; name: string; newName: string }) => Promise<{
        label?: WorkspaceLabelDefinition;
      }>;
      recolor: (input: {
        serverId: string;
        name: string;
        color: WorkspaceLabelDefinition["color"];
      }) => Promise<{ label?: WorkspaceLabelDefinition }>;
      inspectDelete: (input: { serverId: string; name: string }) => Promise<{
        affectedWorkspaceCount: number;
      }>;
      delete: (input: { serverId: string; name: string }) => Promise<unknown>;
    },
  ) {
    super();
    this.currentSnapshot = this.buildSnapshot();
  }

  snapshot = (): WorkspaceLabelManagerSnapshot => this.currentSnapshot;

  syncHosts(hosts: readonly WorkspaceLabelManagerHost[]): void {
    this.hosts = hosts;
    if (!this.operation && !hosts.some((host) => host.serverId === this.serverId)) {
      this.serverId = hosts[0]?.serverId ?? "";
      this.selectedName = null;
      this.draftName = "";
    }
    this.commit();
  }

  selectHost(serverId: string): void {
    if (this.operation || serverId === this.serverId) return;
    this.serverId = serverId;
    this.selectedName = null;
    this.draftName = "";
    this.error = null;
    this.commit();
  }

  selectLabel(name: string): void {
    if (this.operation) return;
    this.selectedName = name;
    this.draftName = name;
    this.error = null;
    this.commit();
  }

  setDraftName(name: string): void {
    this.draftName = name;
    this.commit();
  }

  setQuery(query: string): void {
    this.query = query;
    this.commit();
  }

  rename(): Promise<void> {
    const selected = this.currentSnapshot.selected;
    if (!selected) return Promise.resolve();
    return this.run(async () => {
      const result = await this.dependencies.rename({
        serverId: this.serverId,
        name: selected.name,
        newName: this.draftName,
      });
      const name = result.label?.name ?? normalizeWorkspaceLabelName(this.draftName);
      this.selectedName = name;
      this.draftName = name;
    });
  }

  recolor(color: WorkspaceLabelDefinition["color"]): Promise<void> {
    const selected = this.currentSnapshot.selected;
    if (!selected) return Promise.resolve();
    return this.run(async () => {
      await this.dependencies.recolor({ serverId: this.serverId, name: selected.name, color });
    });
  }

  delete(confirm: (affectedWorkspaceCount: number) => Promise<boolean>): Promise<void> {
    const selected = this.currentSnapshot.selected;
    if (!selected) return Promise.resolve();
    const target = { serverId: this.serverId, name: selected.name };
    return this.run(async () => {
      const inspected = await this.dependencies.inspectDelete(target);
      if (!(await confirm(inspected.affectedWorkspaceCount))) return;
      await this.dependencies.delete(target);
      this.selectedName = null;
      this.draftName = "";
    });
  }

  private run(action: () => Promise<void>): Promise<void> {
    if (this.operation) return this.operation;
    this.error = null;
    this.operation = action()
      .catch((cause: unknown) => {
        this.error = workspaceLabelErrorMessage(cause);
      })
      .finally(() => {
        this.operation = null;
        this.commit();
      });
    this.commit();
    return this.operation;
  }

  private commit(): void {
    this.currentSnapshot = this.buildSnapshot();
    this.publish();
  }

  private buildSnapshot(): WorkspaceLabelManagerSnapshot {
    const host = this.hosts.find((candidate) => candidate.serverId === this.serverId) ?? null;
    const labels = (host?.labels ?? []).filter((label) =>
      label.name.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase()),
    );
    const selected =
      host?.labels.find(
        (label) =>
          this.selectedName !== null &&
          workspaceLabelKey(label.name) === workspaceLabelKey(this.selectedName),
      ) ?? null;
    return {
      hosts: this.hosts,
      serverId: this.serverId,
      selectedName: this.selectedName,
      draftName: this.draftName,
      query: this.query,
      error: this.error,
      pending: this.operation !== null,
      host,
      labels: [...labels],
      selected,
    };
  }
}

/** One phrasing for a failed label mutation, wherever the failure surfaces. */
export function workspaceLabelErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : i18n.t("workspaceLabels.errors.update");
}
