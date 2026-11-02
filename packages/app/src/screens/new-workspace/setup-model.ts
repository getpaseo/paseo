import { useSyncExternalStore } from "react";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { applyMetadataPatch } from "@/composer/draft/metadata";
import type { PickerItem } from "../new-workspace-picker-item";
import {
  initialPickerSelectionState,
  reducePickerSelection,
  type PickerSelectionEvent,
  type PickerSelectionState,
} from "../new-workspace-picker-state";

type Isolation = "local" | "worktree";

/** What the user has chosen on the New workspace screen, apart from project and host. */
interface SetupState {
  pickerSelection: PickerSelectionState;
  manualIsolation: Isolation | null;
  /** The name for a new worktree branch; null lets Paseo pick one. */
  branch: string | null;
  /** The created workspace's metadata. */
  metadata: Readonly<Record<string, JsonValue>>;
}

/**
 * What the screen derives from its hooks and reports on every render, so a command reads it at the
 * moment it runs rather than from the render that built the command.
 */
export interface SetupFacts {
  locked: boolean;
  project: { id: string; name: string } | null;
  canCreateWorktree: boolean;
  supportsMetadata: boolean;
  /** The picker's own handlers, so a command has the effects a pick has. */
  chooseIsolation(isolation: Isolation): void;
  chooseBase(item: PickerItem): void;
}

export interface SetupCommands {
  setIsolation(isolation: Isolation): Promise<void>;
  setBaseRef(ref: { type: "branch"; name: string }): Promise<void>;
  setBranch(name: string | null): Promise<void>;
  setMetadata(patch: Record<string, JsonValue>): Promise<void>;
}

export interface NewWorkspaceSetup {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SetupState;
  dispatchPicker(event: PickerSelectionEvent): void;
  setManualIsolation(isolation: Isolation): void;
  report(facts: SetupFacts): void;
  commands: SetupCommands;
}

const LOCKED_MESSAGE = "The New workspace screen is locked while the workspace is being created.";

/**
 * The New workspace screen's choices as one plain model. The pickers and the plugin commands
 * write to it, so a command sees what an earlier command or pick left, and applies the same rules
 * as the picker it stands in for.
 */
export function createNewWorkspaceSetup(): NewWorkspaceSetup {
  let state: SetupState = {
    pickerSelection: initialPickerSelectionState,
    manualIsolation: null,
    branch: null,
    metadata: {},
  };
  let facts: SetupFacts | null = null;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<SetupState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const unlocked = (): SetupFacts => {
    if (!facts) throw new Error("The New workspace screen is not ready.");
    if (facts.locked) throw new Error(LOCKED_MESSAGE);
    return facts;
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    dispatchPicker: (event) =>
      update({ pickerSelection: reducePickerSelection(state.pickerSelection, event) }),
    setManualIsolation: (manualIsolation) => update({ manualIsolation }),
    report: (next) => {
      facts = next;
    },
    commands: {
      async setIsolation(isolation) {
        const current = unlocked();
        if (isolation === "worktree" && !current.canCreateWorktree) {
          throw new Error("This project cannot create worktrees.");
        }
        current.chooseIsolation(isolation);
      },
      async setBaseRef({ name }) {
        const current = unlocked();
        const refName = name.trim();
        if (!current.project) throw new Error("Choose a project first.");
        if (!refName) throw new Error("A base branch needs a name.");
        current.chooseBase({
          kind: "branch",
          name: refName,
          refName,
          accessibilityLabel: `${refName}, branch`,
        });
      },
      async setBranch(name) {
        unlocked();
        const branch = name === null ? null : name.trim();
        if (branch === "") throw new Error("A branch needs a name.");
        update({ branch });
      },
      async setMetadata(patch) {
        const current = unlocked();
        if (!current.supportsMetadata) throw new Error("Update the host to use metadata.");
        update({ metadata: applyMetadataPatch(state.metadata, patch) });
      },
    },
  };
}

export function useNewWorkspaceSetupState(setup: NewWorkspaceSetup): SetupState {
  return useSyncExternalStore(setup.subscribe, setup.getSnapshot, setup.getSnapshot);
}
