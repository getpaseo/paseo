import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PluginHostProps } from "./contracts.js";

/**
 * The New workspace setup the item sits in. `host` and `project` are the user's choices and are
 * read-only. The commands change what the created workspace is built from, under the same rules as
 * the screen's own pickers.
 */
export interface PluginNewWorkspace {
  readonly host: { readonly id: string; readonly label: string };
  readonly project: { readonly id: string; readonly name: string } | null;
  /** What the screen will create. A project that cannot make worktrees reads `"local"`. */
  readonly isolation: "local" | "worktree";
  /**
   * What a new worktree starts from; `null` until the project's default is known. A branch's
   * `name` is the exact ref creation uses, such as `refs/remotes/origin/main`, so
   * `setBaseRef(newWorkspace.baseRef)` changes nothing.
   */
  readonly baseRef:
    | { readonly type: "branch"; readonly name: string }
    | { readonly type: "change-request"; readonly number: number }
    | null;
  /**
   * The name of the branch a new worktree is created on; `null` lets Paseo pick one. It is kept
   * while isolation is local or the base is a change request. It names the new branch of any
   * worktree that cuts one, from the default base or a chosen branch, and does not apply to a
   * worktree that checks out an existing branch or change request.
   */
  readonly branch: string | null;
  /** The workspace's metadata, not the first agent's. */
  readonly metadata: Readonly<Record<string, JsonValue>>;
  /** Rejects `"worktree"` for a project that cannot make worktrees. */
  setIsolation(isolation: "local" | "worktree"): Promise<void>;
  /**
   * Starts the workspace from a branch. `name` is any ref the Base picker offers, such as
   * `refs/remotes/origin/main`, or a bare branch name, which Paseo resolves the way it does for
   * a branch name it is given anywhere else. Rejects while no project is chosen.
   */
  setBaseRef(ref: { type: "branch"; name: string }): Promise<void>;
  setBranch(name: string | null): Promise<void>;
  /** Top-level keys replace; `null` removes the key. Rejects on a host without metadata support. */
  setMetadata(patch: Record<string, JsonValue>): Promise<void>;
}

export interface PluginNewWorkspaceItemProps extends PluginHostProps {}

export interface PluginNewWorkspaceItemContribution {
  id: string;
  Component: ComponentType<PluginNewWorkspaceItemProps>;
}

const PluginNewWorkspaceContext = createContext<PluginNewWorkspace | null>(null);

export function PluginNewWorkspaceProvider({
  newWorkspace,
  children,
}: {
  newWorkspace: PluginNewWorkspace;
  children: ReactNode;
}) {
  return (
    <PluginNewWorkspaceContext.Provider value={newWorkspace}>
      {children}
    </PluginNewWorkspaceContext.Provider>
  );
}

export function usePluginNewWorkspaceValue(): PluginNewWorkspace | null {
  return useContext(PluginNewWorkspaceContext);
}

/** The New workspace setup this item sits in. Call it from a component registered with `addNewWorkspaceItem`. */
export function useNewWorkspace(): PluginNewWorkspace {
  const newWorkspace = useContext(PluginNewWorkspaceContext);
  if (!newWorkspace) throw new Error("useNewWorkspace must run inside a New workspace item");
  return newWorkspace;
}
