import { normalizeProjectGroupName } from "./key";
import type { ProjectGroupOutcome } from "./index";

export interface ProjectGroupCreateFormMember {
  viewKey: string;
  name: string;
}

export interface ProjectGroupCreateFormState {
  name: string;
  normalizedName: string | null;
  selected: ReadonlySet<string>;
  canSubmit: boolean;
  pending: boolean;
  error: string | null;
}

type Listener = () => void;

export interface ProjectGroupCreateForm {
  subscribe(listener: Listener): () => void;
  getState(): ProjectGroupCreateFormState;
  setName(value: string): void;
  toggleMember(viewKey: string): void;
  submit(): Promise<boolean>;
}

/**
 * Naming a new group and picking which known projects join it, in one form.
 *
 * The projects it can select from are fixed at open time — `members` — so a preselected key that
 * belongs to a project the caller no longer has is dropped rather than carried as a selection
 * nothing can render a row for. Submitting is a single write across every selected project, the
 * same shape as `setProjectGroupOnProjects`; a partial success or failure is the caller's outcome
 * to describe, not this model's to interpret.
 */
export function openProjectGroupCreateForm(input: {
  members: readonly ProjectGroupCreateFormMember[];
  preselectedViewKeys: readonly string[];
  submit: (input: { viewKeys: string[]; group: string }) => Promise<ProjectGroupOutcome>;
  describeOutcome: (outcome: ProjectGroupOutcome) => string | null;
}): ProjectGroupCreateForm {
  const listeners = new Set<Listener>();
  const knownViewKeys = new Set(input.members.map((member) => member.viewKey));

  let name = "";
  let selected = new Set(input.preselectedViewKeys.filter((key) => knownViewKeys.has(key)));
  let pending = false;
  let error: string | null = null;
  let snapshot = buildSnapshot();

  function buildSnapshot(): ProjectGroupCreateFormState {
    const normalizedName = normalizeProjectGroupName(name);
    return {
      name,
      normalizedName,
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
      pending = true;
      error = null;
      commit();
      try {
        const outcome = await input.submit({
          viewKeys: Array.from(selected),
          group: normalizedName,
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
