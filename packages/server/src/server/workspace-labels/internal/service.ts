import {
  normalizeWorkspaceLabelName,
  workspaceLabelKey,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { WorkspaceLabelCatalogStore } from "./catalog-store.js";
import {
  WorkspaceLabelSequence,
  type WorkspaceLabelChange,
  type WorkspaceLabelCursor,
} from "./sequence.js";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";

interface AssignmentCommit {
  definition: WorkspaceLabelDefinition;
  workspaceLabels: string[];
  catalogChanged: boolean;
}

interface UpdateCommit {
  label: WorkspaceLabelDefinition;
  affectedWorkspaceCount: number;
  changed: boolean;
  previousName?: string;
}

interface DeleteCommit {
  affectedWorkspaceCount: number;
  deletedName: string | null;
}

export class WorkspaceLabelError extends Error {
  constructor(
    public readonly code:
      | "label_name_empty"
      | "label_not_found"
      | "label_name_taken"
      | "workspace_not_found",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceLabelError";
  }
}

export class WorkspaceLabelService {
  private operations: Promise<void> = Promise.resolve();

  constructor(
    private readonly catalog: WorkspaceLabelCatalogStore,
    private readonly sequence = new WorkspaceLabelSequence(),
  ) {}

  async initialize(): Promise<void> {
    await this.catalog.initialize();
  }

  async subscribe(input: {
    cursor?: WorkspaceLabelCursor;
    onChange: (change: WorkspaceLabelChange & { generation: string; seq: number }) => void;
  }): Promise<{
    snapshot: ReturnType<WorkspaceLabelSequence["synchronize"]>;
    unsubscribe: () => void;
  }> {
    return this.exclusive(async () => {
      const unsubscribe = this.sequence.subscribe((entry) =>
        input.onChange({ ...entry.change, generation: entry.generation, seq: entry.seq }),
      );
      try {
        const labels = await this.catalog.list();
        return { snapshot: this.sequence.synchronize(labels, input.cursor), unsubscribe };
      } catch (error) {
        unsubscribe();
        throw error;
      }
    });
  }

  async setAssignment(input: {
    workspaceId: string;
    label: WorkspaceLabelDefinition;
    assigned: boolean;
  }): Promise<{ label: WorkspaceLabelDefinition; workspaceLabels: string[] }> {
    return this.exclusive(async () => {
      const name = requireName(input.label.name);
      const committed = await this.catalog.commit<AssignmentCommit>((catalog, workspaces) => {
        const workspace = workspaces.get(input.workspaceId);
        if (!workspace || workspace.archivedAt) {
          throw new WorkspaceLabelError("workspace_not_found", "Workspace not found");
        }
        const key = workspaceLabelKey(name);
        const existing = catalog.find((label) => workspaceLabelKey(label.name) === key);
        const definition = existing ?? { name, color: input.label.color };
        const current = workspace.labels ?? [];
        const workspaceLabels = updateAssignmentLabels(
          current,
          key,
          definition.name,
          input.assigned,
        );
        const workspaceChanged = workspaceLabels !== current;
        const catalogChanged = !existing && input.assigned;
        return {
          labels: catalogChanged ? [...catalog, definition] : [...catalog],
          workspaceUpdates: workspaceChanged
            ? [
                {
                  ...workspace,
                  labels: workspaceLabels.length > 0 ? workspaceLabels : undefined,
                  updatedAt: new Date().toISOString(),
                },
              ]
            : [],
          result: { definition, workspaceLabels, catalogChanged },
        };
      });
      if (committed.catalogChanged) {
        this.sequence.publish({ kind: "upsert", label: committed.definition });
      }
      return { label: committed.definition, workspaceLabels: committed.workspaceLabels };
    });
  }

  /**
   * Edit a label: a new name, a new colour, or both, in one catalog commit.
   *
   * Both fields are optional and an omitted field is left alone. They travel together because
   * the alternative — a rename that succeeds and a recolour that then fails — leaves the catalog
   * in a state nobody asked for and no client can describe.
   *
   * Renaming onto a name the host already has is rejected, not merged. Merging would fold two
   * labels' assignments together with no way back, and the user asked to edit one label. The
   * check happens inside the planner, so a rejected collision applies neither field.
   */
  async update(input: {
    name: string;
    newName?: string;
    color?: WorkspaceLabelDefinition["color"];
  }): Promise<{ label: WorkspaceLabelDefinition; affectedWorkspaceCount: number }> {
    return this.exclusive(async () => {
      const fromKey = workspaceLabelKey(requireName(input.name));
      const newName = input.newName === undefined ? null : requireName(input.newName);
      const committed = await this.catalog.commit<UpdateCommit>((catalog, workspaces) => {
        const existing = catalog.find((label) => workspaceLabelKey(label.name) === fromKey);
        if (!existing) throw new WorkspaceLabelError("label_not_found", "Label not found");
        // A label keeping its own key is not colliding with itself, so case-only edits pass.
        if (newName !== null && workspaceLabelKey(newName) !== fromKey) {
          const toKey = workspaceLabelKey(newName);
          if (catalog.some((label) => workspaceLabelKey(label.name) === toKey)) {
            throw new WorkspaceLabelError(
              "label_name_taken",
              "A label with that name already exists",
            );
          }
        }
        const nameChanged = newName !== null && newName !== existing.name;
        const colorChanged = input.color !== undefined && input.color !== existing.color;
        if (!nameChanged && !colorChanged) {
          return {
            labels: [...catalog],
            workspaceUpdates: [],
            result: { label: existing, affectedWorkspaceCount: 0, changed: false },
          };
        }
        const label = {
          name: nameChanged && newName !== null ? newName : existing.name,
          color: input.color ?? existing.color,
        };
        // Workspaces store names, so only a rename rewrites assignments; a recolour is catalog-only.
        const workspaceUpdates = nameChanged
          ? rewriteAssignments(workspaces, fromKey, label.name)
          : [];
        return {
          labels: catalog.map((candidate) => (candidate === existing ? label : candidate)),
          workspaceUpdates,
          result: {
            label,
            affectedWorkspaceCount: workspaceUpdates.length,
            changed: true,
            ...(nameChanged ? { previousName: existing.name } : {}),
          },
        };
      });
      if (committed.changed) {
        this.sequence.publish({
          kind: "upsert",
          label: committed.label,
          previousName: committed.previousName,
        });
      }
      return {
        label: committed.label,
        affectedWorkspaceCount: committed.affectedWorkspaceCount,
      };
    });
  }

  async delete(nameInput: string): Promise<{ affectedWorkspaceCount: number }> {
    return this.exclusive(async () => {
      const key = workspaceLabelKey(requireName(nameInput));
      const committed = await this.catalog.commit<DeleteCommit>((catalog, workspaces) => {
        const existing = catalog.find((label) => workspaceLabelKey(label.name) === key);
        if (!existing) {
          return {
            labels: [...catalog],
            workspaceUpdates: [],
            result: { affectedWorkspaceCount: 0, deletedName: null },
          };
        }
        const workspaceUpdates = rewriteAssignments(workspaces, key);
        return {
          labels: catalog.filter((label) => label !== existing),
          workspaceUpdates,
          result: {
            affectedWorkspaceCount: workspaceUpdates.length,
            deletedName: existing.name,
          },
        };
      });
      if (committed.deletedName) {
        this.sequence.publish({ kind: "remove", name: committed.deletedName });
      }
      return { affectedWorkspaceCount: committed.affectedWorkspaceCount };
    });
  }

  async countAffectedWorkspaces(nameInput: string): Promise<number> {
    return this.exclusive(() => {
      const key = workspaceLabelKey(requireName(nameInput));
      return this.catalog.commit((catalog, workspaces) => ({
        labels: [...catalog],
        workspaceUpdates: [],
        result: [...workspaces.values()].filter((workspace) => workspaceHasLabel(workspace, key))
          .length,
      }));
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operations;
    let release!: () => void;
    this.operations = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function updateAssignmentLabels(
  current: string[],
  key: string,
  displayName: string,
  assigned: boolean,
): string[] {
  const assignedIndex = current.findIndex((label) => workspaceLabelKey(label) === key);
  if (assigned) return assignedIndex === -1 ? [...current, displayName] : current;
  return assignedIndex === -1 ? current : current.filter((_, index) => index !== assignedIndex);
}

function workspaceHasLabel(workspace: PersistedWorkspaceRecord, key: string): boolean {
  return (workspace.labels ?? []).some((label) => workspaceLabelKey(label) === key);
}

function rewriteAssignments(
  workspaces: ReadonlyMap<string, PersistedWorkspaceRecord>,
  fromKey: string,
  to?: string,
): PersistedWorkspaceRecord[] {
  const now = new Date().toISOString();
  return [...workspaces.values()].flatMap((workspace) => {
    const labels = workspace.labels ?? [];
    if (!labels.some((label) => workspaceLabelKey(label) === fromKey)) return [];
    const next = labels.flatMap((label) => {
      if (workspaceLabelKey(label) !== fromKey) return [label];
      return to ? [to] : [];
    });
    return [
      {
        ...workspace,
        labels: next.length > 0 ? next : undefined,
        updatedAt: now,
      },
    ];
  });
}

function requireName(raw: string): string {
  const name = normalizeWorkspaceLabelName(raw);
  if (name.length === 0) {
    throw new WorkspaceLabelError("label_name_empty", "Label name cannot be empty");
  }
  return name;
}
