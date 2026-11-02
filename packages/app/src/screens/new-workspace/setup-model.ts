import { useSyncExternalStore } from "react";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { applyMetadataPatch } from "@/composer/draft/metadata";
import { branchNameFromRef, type PickerItem } from "../new-workspace-picker-item";
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
 * What the screen derives from its hooks, given at construction and kept current on every
 * commit, so a command reads it at the moment it runs rather than from the render that built it.
 */
export interface SetupInputs {
  locked: boolean;
  project: { id: string; name: string } | null;
  canCreateWorktree: boolean;
  supportsMetadata: boolean;
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
  /** Events other than a pick: a detected change request, a target change. */
  dispatchPicker(event: PickerSelectionEvent): void;
  /** The base picker's entry, and the one `setBaseRef` takes. */
  chooseBase(item: PickerItem): void;
  /** The isolation picker's entry, and the one `setIsolation` takes. */
  chooseIsolation(isolation: Isolation): void;
  /** What the screen does beyond changing the model when a pick lands; returns the remover. */
  onBaseChosen(listener: (item: PickerItem) => void): () => void;
  onIsolationChosen(listener: (isolation: Isolation) => void): () => void;
  syncInputs(inputs: SetupInputs): void;
  commands: SetupCommands;
}

const LOCKED_MESSAGE = "The New workspace screen is locked while the workspace is being created.";

/**
 * The New workspace screen's choices as one plain model. The pickers and the plugin commands
 * write to it through the same entries, so a command sees what an earlier command or pick left,
 * has the effects of a pick, and applies the same rules as the picker it stands in for. It is
 * built with its inputs, so a command is valid from the first render.
 */
export function createNewWorkspaceSetup(initial: SetupInputs): NewWorkspaceSetup {
  let state: SetupState = {
    pickerSelection: initialPickerSelectionState,
    manualIsolation: null,
    branch: null,
    metadata: {},
  };
  let inputs = initial;
  let baseChosen: (item: PickerItem) => void = () => {};
  let isolationChosen: (isolation: Isolation) => void = () => {};
  const listeners = new Set<() => void>();
  const update = (patch: Partial<SetupState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const unlocked = (): SetupInputs => {
    if (inputs.locked) throw new Error(LOCKED_MESSAGE);
    return inputs;
  };
  const dispatchPicker = (event: PickerSelectionEvent) =>
    update({ pickerSelection: reducePickerSelection(state.pickerSelection, event) });
  const chooseBase = (item: PickerItem) => {
    dispatchPicker({ type: "picker-selected", item });
    baseChosen(item);
  };
  const chooseIsolation = (isolation: Isolation) => {
    update({ manualIsolation: isolation });
    isolationChosen(isolation);
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    dispatchPicker,
    chooseBase,
    chooseIsolation,
    onBaseChosen(listener) {
      baseChosen = listener;
      return () => {
        baseChosen = () => {};
      };
    },
    onIsolationChosen(listener) {
      isolationChosen = listener;
      return () => {
        isolationChosen = () => {};
      };
    },
    syncInputs: (next) => {
      inputs = next;
    },
    commands: {
      async setIsolation(isolation) {
        const current = unlocked();
        if (isolation === "worktree" && !current.canCreateWorktree) {
          throw new Error("This project cannot create worktrees.");
        }
        chooseIsolation(isolation);
      },
      async setBaseRef({ name }) {
        const current = unlocked();
        const refName = name.trim();
        if (!current.project) throw new Error("Choose a project first.");
        if (!refName) throw new Error("A base branch needs a name.");
        chooseBase({
          kind: "branch",
          name: branchNameFromRef(refName),
          refName,
          accessibilityLabel: `${branchNameFromRef(refName)}, branch`,
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
