import type { PluginHookContext, PluginWorktreeCreateRequest } from "./lifecycle.js";

/** Context passed to worktree manager callbacks. */
export type PluginWorktreeContext = PluginHookContext;

/** Resolved creation request handed to a worktree manager after `worktree.create.before`. */
export type PluginWorktreeCreateInput = PluginWorktreeCreateRequest & {
  /** True when the worktree comes from an untrusted source such as a fork change request; skip repository-defined hooks. */
  readonly untrusted: boolean;
  /** Resolved remote head commit SHA for change-request checkouts when available. */
  readonly headSha?: string;
};

/** Return `{ type: "created", path }` to claim creation, or `undefined` to decline. */
export interface PluginWorktreeCreateResult {
  type: "created";
  path: string;
}

export interface PluginWorktreeRemoveRequest {
  readonly repoRoot: string | null;
  readonly path: string;
  readonly branch: string | null;
  readonly reason: "archive" | "rollback";
  readonly force: boolean;
  /** True when the worktree came from an untrusted source such as a fork change request; skip repository-defined hooks. */
  readonly untrusted: boolean;
}

/** Return `{ type: "removed" }` after removing the worktree, or `undefined` to fall back to Git. */
export interface PluginWorktreeRemoveResult {
  type: "removed";
}

export type PluginWorktreeRestoreTarget =
  | { readonly type: "branch"; readonly branch: string }
  | { readonly type: "commit"; readonly commit: string }
  | { readonly type: "from-base"; readonly branch: string; readonly baseRef: string };

export interface PluginWorktreeRestoreRequest {
  readonly repoRoot: string;
  /** Recorded path the worktree must be restored to. */
  readonly path: string;
  readonly target: PluginWorktreeRestoreTarget;
  readonly baseRef: string | null;
  /** True when the worktree came from an untrusted source such as a fork change request; skip repository-defined hooks. */
  readonly untrusted: boolean;
}

/** Return `{ type: "restored", path }` after recreating the worktree, or `undefined` to fall back to Git. */
export interface PluginWorktreeRestoreResult {
  type: "restored";
  path: string;
}

export interface WorktreeManagerRegistration {
  create(
    request: PluginWorktreeCreateInput,
    context: PluginWorktreeContext,
  ): Promise<PluginWorktreeCreateResult | void>;
  remove?(
    request: PluginWorktreeRemoveRequest,
    context: PluginWorktreeContext,
  ): Promise<PluginWorktreeRemoveResult | void>;
  restore?(
    request: PluginWorktreeRestoreRequest,
    context: PluginWorktreeContext,
  ): Promise<PluginWorktreeRestoreResult | void>;
}
