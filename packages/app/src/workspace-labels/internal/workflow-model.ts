import {
  normalizeWorkspaceLabelName,
  workspaceLabelKey,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { buildWorkspaceLabelPicker } from "./picker-model";
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
  query: string;
  creating: boolean;
  createName: string;
  error: string | null;
  online: boolean;
  pendingNames: string[];
  picker: ReturnType<typeof buildWorkspaceLabelPicker>;
}

export class WorkspaceLabelPickerModel extends ObservableModel {
  private query = "";
  private creating = false;
  private createName = "";
  private error: string | null = null;
  private online = false;
  private labels: readonly WorkspaceLabelDefinition[] = [];
  private assigned: readonly string[] = [];
  private readonly pending = new Map<string, Promise<boolean>>();
  private currentSnapshot: WorkspaceLabelPickerModelSnapshot;

  constructor(
    private readonly dependencies: {
      mutate: (input: { label: WorkspaceLabelDefinition; assigned: boolean }) => Promise<unknown>;
      close: () => void;
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

  setQuery(query: string): void {
    this.query = query;
    this.commit();
  }

  beginCreate(): void {
    this.createName = this.currentSnapshot.picker.create.name;
    this.creating = true;
    this.error = null;
    this.commit();
  }

  setCreateName(name: string): void {
    this.createName = name;
    this.commit();
  }

  create(color: WorkspaceLabelDefinition["color"]): Promise<boolean> {
    const name = normalizeWorkspaceLabelName(this.createName);
    if (!name) return Promise.resolve(false);
    return this.runMutation({ name, color }, true, "row");
  }

  toggle(
    label: WorkspaceLabelDefinition,
    assigned: boolean,
    source: "row" | "checkbox",
  ): Promise<boolean> {
    return this.runMutation(label, assigned, source);
  }

  private runMutation(
    label: WorkspaceLabelDefinition,
    assigned: boolean,
    source: "row" | "checkbox",
  ): Promise<boolean> {
    const key = workspaceLabelKey(label.name);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    this.error = null;
    const operation = this.dependencies
      .mutate({ label, assigned })
      .then(() => {
        if (source === "row") this.dependencies.close();
        return true;
      })
      .catch((cause: unknown) => {
        this.error = errorMessage(cause);
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
      query: this.query,
      creating: this.creating,
      createName: this.createName,
      error: this.error,
      online: this.online,
      pendingNames: [...this.pending.keys()],
      picker: buildWorkspaceLabelPicker({
        labels: this.labels,
        assigned: this.assigned,
        query: this.query,
      }),
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
        this.error = errorMessage(cause);
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : i18n.t("workspaceLabels.errors.update");
}
