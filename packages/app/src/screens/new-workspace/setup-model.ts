import { useSyncExternalStore } from "react";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { CheckoutWorktree } from "@getpaseo/protocol/messages";
import { applyMetadataPatch } from "@/composer/draft/metadata";
import {
  branchNameFromRef,
  DEFAULT_REF_ACTION,
  pickerItemToCheckoutRequest,
  type PickerCheckoutRequest,
  type PickerItem,
  type RefAction,
} from "../new-workspace-picker-item";
import {
  initialPickerSelectionState,
  reducePickerSelection,
  type PickerSelectionEvent,
  type PickerSelectionState,
} from "../new-workspace-picker-state";

type Isolation = "local" | "worktree";
type RefKind = PickerItem["kind"];

/** What the user has chosen on the New workspace screen, apart from project and host. */
interface SetupState {
  pickerSelection: PickerSelectionState;
  manualIsolation: Isolation | null;
  /** The name for a new worktree branch; null lets Paseo pick one. */
  branch: string | null;
  /** The created workspace's metadata. */
  metadata: Readonly<Record<string, JsonValue>>;
  /**
   * The git worktree the workspace works in when the user chose Existing worktree. That is a
   * local workspace at the worktree's path, so the isolation underneath stays as it was.
   */
  existingWorktreePath: string | null;
  /** The action the user switched to, per kind of ref; a kind without one uses its default. */
  refActions: Partial<Record<RefKind, RefAction>>;
}

/**
 * What the screen derives from its hooks, given at construction and kept current on every
 * commit, so a command reads it at the moment it runs rather than from the render that built it.
 */
export interface SetupInputs {
  /** The host the screen creates on; a project id alone can repeat across hosts. */
  serverId: string;
  locked: boolean;
  project: { id: string; name: string } | null;
  canCreateWorktree: boolean;
  supportsMetadata: boolean;
  /** Whether the host can branch off a pull request, so the user may pick either action. */
  supportsRefActions: boolean;
  /** The project's git worktrees, the project directory's own among them. */
  worktrees: readonly CheckoutWorktree[];
}

/** The project on the host a screen creates in; what an item is mounted for. */
export interface SetupTarget {
  serverId: string;
  /** Null while the screen is still resolving its project. */
  projectId: string | null;
}

export function setupTargetOf(input: Pick<SetupInputs, "serverId" | "project">): SetupTarget {
  return { serverId: input.serverId, projectId: input.project?.id ?? null };
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
  /** The Existing worktree picker's entry. Not remembered as the next screen's default. */
  chooseExistingWorktree(path: string): void;
  /**
   * The ref picker's entry. Checking out a branch that a worktree already holds works in that
   * worktree, since git keeps a branch in one worktree at a time.
   */
  chooseRef(item: PickerItem): void;
  chooseRefAction(kind: RefKind, action: RefAction): void;
  refActionFor(kind: RefKind): RefAction;
  /** What creating a new worktree from `item` asks the host for. */
  checkoutRequestFor(item: PickerItem | null): PickerCheckoutRequest | undefined;
  syncInputs(inputs: SetupInputs): void;
  /**
   * Commands for the items mounted for `target`. Once the screen is on another project or host
   * they reject, so a lookup that finishes after the switch cannot write into the new choices.
   */
  commandsFor(target: SetupTarget): SetupCommands;
}

/** What a pick does beyond changing the model, the same for the picker and for a command. */
export interface SetupEffects {
  /** Remembers the isolation as the default for the next New workspace screen. */
  persistIsolation(isolation: Isolation): void;
  /** Keeps the picker's change-request attachment in step with the chosen base. */
  syncBaseAttachment(item: PickerItem): void;
}

/** The action a pick of `kind` takes: the user's switch, on a host that allows one, else the default. */
export function refActionOf(input: {
  refActions: SetupState["refActions"];
  supportsRefActions: boolean;
  kind: RefKind;
}): RefAction {
  const chosen = input.supportsRefActions ? input.refActions[input.kind] : undefined;
  return chosen ?? DEFAULT_REF_ACTION[input.kind];
}

/** The worktree that has `branchName` checked out. Git keeps a branch in one worktree at a time. */
export function worktreeHoldingBranch(
  worktrees: readonly CheckoutWorktree[],
  branchName: string,
): CheckoutWorktree | undefined {
  return worktrees.find((worktree) => worktree.branchName === branchName);
}

/** A checkout of a branch that is already checked out in another worktree. */
export class BranchInWorktreeError extends Error {
  readonly branchName: string;
  readonly worktree: CheckoutWorktree;

  constructor(params: { branchName: string; worktree: CheckoutWorktree }) {
    super(`${params.branchName} is already checked out in ${params.worktree.path}`);
    this.name = "BranchInWorktreeError";
    this.branchName = params.branchName;
    this.worktree = params.worktree;
  }
}

const MOVED_MESSAGE =
  "The New workspace screen moved to another project or host; this item belongs to the previous one.";
const LOCKED_MESSAGE = "The New workspace screen is locked while the workspace is being created.";

/**
 * The New workspace screen's choices as one plain model. The pickers and the plugin commands
 * write to it through the same entries, so a command sees what an earlier command or pick left,
 * has the effects of a pick, and applies the same rules as the picker it stands in for. It is
 * built with its inputs and effects, so a command does the same thing from a child's mount effect
 * as from a button later.
 */
export function createNewWorkspaceSetup(
  initial: SetupInputs,
  effects: SetupEffects,
): NewWorkspaceSetup {
  let state: SetupState = {
    pickerSelection: initialPickerSelectionState,
    manualIsolation: null,
    branch: null,
    metadata: {},
    existingWorktreePath: null,
    refActions: {},
  };
  let inputs = initial;
  let screenTarget = initial.project ? `${initial.serverId}\n${initial.project.id}` : null;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<SetupState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const sameTarget = (target: SetupTarget) => {
    const current = setupTargetOf(inputs);
    return current.serverId === target.serverId && current.projectId === target.projectId;
  };
  const dispatchPicker = (event: PickerSelectionEvent) =>
    update({ pickerSelection: reducePickerSelection(state.pickerSelection, event) });
  const chooseBase = (item: PickerItem) => {
    dispatchPicker({ type: "picker-selected", item });
    effects.syncBaseAttachment(item);
  };
  const chooseIsolation = (isolation: Isolation) => {
    update({ manualIsolation: isolation, existingWorktreePath: null });
    effects.persistIsolation(isolation);
  };
  const refActionFor = (kind: RefKind): RefAction =>
    refActionOf({
      refActions: state.refActions,
      supportsRefActions: inputs.supportsRefActions,
      kind,
    });
  /** The worktree a checkout of `item` would collide with, if `item` is a branch one holds. */
  const worktreeHolding = (item: PickerItem): CheckoutWorktree | undefined => {
    if (item.kind !== "branch" || refActionFor(item.kind) !== "checkout") return undefined;
    return worktreeHoldingBranch(inputs.worktrees, branchNameFromRef(item.refName));
  };
  const chooseRef = (item: PickerItem) => {
    const holder = worktreeHolding(item);
    if (!holder) {
      chooseBase(item);
      return;
    }
    // The project directory is Project directory, not one of the existing worktrees.
    update(
      holder.containsCwd
        ? { manualIsolation: "local", existingWorktreePath: null }
        : { existingWorktreePath: holder.path },
    );
  };
  const commandsFor = (target: SetupTarget): SetupCommands => {
    const unlocked = (): SetupInputs => {
      if (!sameTarget(target)) throw new Error(MOVED_MESSAGE);
      if (inputs.locked) throw new Error(LOCKED_MESSAGE);
      return inputs;
    };
    return {
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
        // A base is what a new worktree starts from, so the worktree branches off it.
        update({ refActions: { ...state.refActions, branch: "branch-off" } });
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
    };
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
    chooseExistingWorktree: (path) => update({ existingWorktreePath: path }),
    chooseRef,
    chooseRefAction: (kind, action) =>
      update({ refActions: { ...state.refActions, [kind]: action } }),
    refActionFor,
    checkoutRequestFor: (item) => {
      if (!item) return undefined;
      const holder = worktreeHolding(item);
      if (holder?.branchName) {
        throw new BranchInWorktreeError({ branchName: holder.branchName, worktree: holder });
      }
      return pickerItemToCheckoutRequest(item, refActionFor(item.kind));
    },
    syncInputs: (next) => {
      inputs = next;
      // A branch and metadata are chosen for one project on one host. A project id can repeat
      // across hosts (a remote repository keeps its key everywhere), so the host is part of the
      // target. An absent project is a screen that is still resolving, not a switch.
      if (!next.project) return;
      const nextTarget = `${next.serverId}\n${next.project.id}`;
      if (screenTarget && screenTarget !== nextTarget) {
        update({ branch: null, metadata: {}, existingWorktreePath: null });
      }
      screenTarget = nextTarget;
    },
    commandsFor,
  };
}

export function useNewWorkspaceSetupState(setup: NewWorkspaceSetup): SetupState {
  return useSyncExternalStore(setup.subscribe, setup.getSnapshot, setup.getSnapshot);
}
