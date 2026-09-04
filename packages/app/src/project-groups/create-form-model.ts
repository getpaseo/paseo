import { normalizeProjectGroupName, projectGroupKey } from "./key";
import type { ProjectGroupOption, ProjectGroupOutcome } from "./index";

export interface ProjectGroupCreateFormMember {
  viewKey: string;
  name: string;
  /** The group the project is in when the form opens; a member can only be in one at a time. */
  group: string | null;
}

export interface ProjectGroupCreateFormState {
  name: string;
  normalizedName: string | null;
  /**
   * The known group the typed name lands in, or null when the name is new. Groups have no
   * catalog, so "Client X" typed here does not create a second "Client X": it adds the selected
   * projects to the one that exists. The sheet says so on its button.
   */
  existingGroup: ProjectGroupOption | null;
  selected: ReadonlySet<string>;
  canSubmit: boolean;
  pending: boolean;
  error: string | null;
}

export interface ProjectGroupCreateFormSections {
  /** Projects in no group, listed first: joining a new group costs them nothing. */
  ungrouped: ProjectGroupCreateFormMember[];
  /** Projects already in a group, which the write would move out of it. */
  grouped: ProjectGroupCreateFormMember[];
}

type Listener = () => void;

export interface ProjectGroupCreateForm {
  subscribe(listener: Listener): () => void;
  getState(): ProjectGroupCreateFormState;
  setName(value: string): void;
  toggleMember(viewKey: string): void;
  submit(): Promise<boolean>;
}

/** Splits the member list by whether joining would move the project out of a group. */
export function partitionProjectGroupCreateMembers(
  members: readonly ProjectGroupCreateFormMember[],
): ProjectGroupCreateFormSections {
  const ungrouped: ProjectGroupCreateFormMember[] = [];
  const grouped: ProjectGroupCreateFormMember[] = [];
  for (const member of members) {
    (member.group === null ? ungrouped : grouped).push(member);
  }
  return { ungrouped, grouped };
}

/**
 * Naming a new group and picking which known projects join it, in one form.
 *
 * The projects it can select from are fixed at open time — `members` — so a preselected key that
 * belongs to a project the caller no longer has is dropped rather than carried as a selection
 * nothing can render a row for. `knownGroups` is fixed the same way: it decides whether the name
 * is new, and a group appearing on a host mid-typing would otherwise flip the button under the
 * pointer. Submitting is a single write across every selected project, the same shape as
 * `setProjectGroupOnProjects`; a partial success or failure is the caller's outcome to describe,
 * not this model's to interpret.
 */
export function openProjectGroupCreateForm(input: {
  members: readonly ProjectGroupCreateFormMember[];
  knownGroups: readonly ProjectGroupOption[];
  preselectedViewKeys: readonly string[];
  submit: (input: { viewKeys: string[]; group: string }) => Promise<ProjectGroupOutcome>;
  describeOutcome: (outcome: ProjectGroupOutcome) => string | null;
}): ProjectGroupCreateForm {
  const listeners = new Set<Listener>();
  const knownViewKeys = new Set(input.members.map((member) => member.viewKey));
  const knownGroupsByKey = new Map(input.knownGroups.map((group) => [group.key, group]));

  let name = "";
  let selected = new Set(input.preselectedViewKeys.filter((key) => knownViewKeys.has(key)));
  let pending = false;
  let error: string | null = null;
  let snapshot = buildSnapshot();

  function buildSnapshot(): ProjectGroupCreateFormState {
    const normalizedName = normalizeProjectGroupName(name);
    const existingGroup =
      normalizedName === null
        ? null
        : (knownGroupsByKey.get(projectGroupKey(normalizedName)) ?? null);
    return {
      name,
      normalizedName,
      existingGroup,
      selected,
      canSubmit: normalizedName !== null && selected.size > 0 && !pending,
      pending,
      error,
    };
  }

  function commit(): void {
    snapshot = buildSnapshot();
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState() {
      return snapshot;
    },
    setName(value) {
      if (value === name) return;
      name = value;
      error = null;
      commit();
    },
    toggleMember(viewKey) {
      if (!knownViewKeys.has(viewKey)) return;
      const next = new Set(selected);
      if (next.has(viewKey)) {
        next.delete(viewKey);
      } else {
        next.add(viewKey);
      }
      selected = next;
      commit();
    },
    async submit() {
      if (!snapshot.canSubmit) return false;
      const normalizedName = snapshot.normalizedName;
      if (!normalizedName) return false;
      // Joining an existing group writes its spelling, not the typed one: "client x" typed into
      // "Client X" is a join, and the rename page is where casing changes on purpose.
      const group = snapshot.existingGroup?.name ?? normalizedName;
      pending = true;
      error = null;
      commit();
      try {
        const outcome = await input.submit({
          viewKeys: Array.from(selected),
          group,
        });
        const message = input.describeOutcome(outcome);
        if (message) {
          error = message;
          return false;
        }
        return true;
      } finally {
        pending = false;
        commit();
      }
    },
  };
}
