import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  createWorktree,
  deletePaseoWorktree,
  seedPaseoConfigFile,
  type WorktreeSource,
} from "../../../utils/worktree.js";
import type {
  WorkspaceDriverCreateInput,
  WorkspaceDriverInspection,
  WorkspaceDriverSpawnInput,
  WorkspaceDriverState,
  WorkspaceRuntimeDriver,
} from "../drivers/index.js";
import { resolveRuntimeCwd, spawnHostProcess, spawnHostPty } from "./host-process.js";
import { hostWorkspaceHelper } from "./host-helper.js";
import type { HostGitObservationOwner } from "./host-git-observation.js";
import { createRuntimeStateStore } from "./runtime-state.js";
import { writePaseoWorktreeFirstAgentBranchAutoNameMetadata } from "../../../utils/worktree-metadata.js";
import { createExternalProcessEnv } from "../../paseo-env.js";
import { createStringCommandShellEnv } from "../../../utils/string-command-shell.js";
import { runGitCommand } from "../../../utils/run-git-command.js";
import { createRealpathAwarePathMatcher } from "../../../utils/path.js";

interface WorktreeRuntimeState {
  workspaceId: string;
  root: string;
  sourceRoot: string;
  worktreeRoot: string;
  lifecycle: "ready" | "paused";
  lifecycleEnvironment: Readonly<Record<string, string>>;
  branchName?: string;
  relativeCwd?: string;
  ownsWorktree?: boolean;
}

export function createWorktreeRuntime(options: {
  paseoHome: string;
  worktreesRoot?: string;
  hostGitObservations: HostGitObservationOwner;
}): WorkspaceRuntimeDriver {
  const states = createRuntimeStateStore(options.paseoHome, "worktree", isWorktreeRuntimeState);

  async function inspect(workspaceId: string): Promise<WorkspaceDriverInspection> {
    const state = await states.read(workspaceId);
    if (!state) return { status: "missing" };
    if (state.lifecycle === "paused") {
      return {
        status: "paused",
        state: publicState(state),
        placement: hostPlacement(state.root),
      };
    }
    try {
      if (!(await stat(state.root)).isDirectory()) return { status: "missing" };
      return {
        status: state.lifecycle,
        state: publicState(state),
        placement: hostPlacement(state.root),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "error", message: String(error) };
    }
  }

  async function requireReady(workspaceId: string): Promise<WorktreeRuntimeState> {
    const state = await states.read(workspaceId);
    if (!state || state.lifecycle !== "ready") {
      throw new Error(
        `Workspace runtime worktree is ${state?.lifecycle ?? "missing"}: ${workspaceId}`,
      );
    }
    return state;
  }

  return {
    id: "worktree",
    requiresGitProject: true,
    workspaceHelper: hostWorkspaceHelper,
    scriptTerminal: { kind: "persistent-shell" },
    provider: {
      environment: "inherit-sanitized-host",
      sharedHostProviders: new Set(["opencode"]),
    },
    setupEnvironment: () => createStringCommandShellEnv(createExternalProcessEnv(process.env)),
    async create(input: WorkspaceDriverCreateInput) {
      const existing = await inspect(input.workspaceId);
      if (existing.status === "ready" || existing.status === "paused") {
        return { ...existing, materializedFreshContent: false };
      }
      if (input.project.source.kind !== "host-directory") {
        throw new Error("The worktree runtime requires a host Git checkout");
      }
      if (input.purpose === "provider-probe") {
        if (input.placement.kind !== "existing") {
          throw new Error("A worktree provider probe adopts an existing Git checkout");
        }
        const sourceRoot = path.resolve(input.project.source.path);
        const root = await resolveRuntimeCwd(sourceRoot, input.placement.relativeCwd);
        if (!(await stat(root)).isDirectory()) throw new Error(`Directory not found: ${root}`);
        const state: WorktreeRuntimeState = {
          workspaceId: input.workspaceId,
          root,
          worktreeRoot: sourceRoot,
          sourceRoot,
          lifecycle: "ready",
          lifecycleEnvironment: {},
          ownsWorktree: false,
        };
        await states.write(state);
        return {
          state: publicState(state),
          placement: hostPlacement(root),
          materializedFreshContent: false,
        };
      }
      if (input.placement.kind === "existing") {
        throw new Error("The worktree runtime creates and owns its worktree");
      }
      const sourceRoot = path.resolve(input.project.source.path);
      const worktreeSlug =
        input.placement.kind === "resolved-worktree"
          ? input.placement.worktreeSlug
          : (input.placement.worktreeSlug ?? input.workspaceId);
      const worktree = await createWorktree({
        cwd: sourceRoot,
        source: toWorktreeSource(input.placement),
        worktreeSlug,
        runSetup: false,
        paseoHome: options.paseoHome,
        worktreesRoot: options.worktreesRoot,
      });
      try {
        if (
          input.markFirstAgentBranchAutoName &&
          input.placement.kind === "resolved-worktree" &&
          input.placement.source.kind === "branch-off"
        ) {
          writePaseoWorktreeFirstAgentBranchAutoNameMetadata(worktree.worktreePath, {
            placeholderBranchName: worktree.branchName,
          });
        }
        const root = await resolveRuntimeCwd(
          worktree.worktreePath,
          input.placement.relativeCwd,
        ).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error("Selected project directory is missing from the worktree", {
              cause: error,
            });
          }
          throw error;
        });
        if (input.seedPaseoConfigFrom) {
          await seedPaseoConfigFile({ sourceCwd: input.seedPaseoConfigFrom, targetCwd: root });
        }
        if (!(await stat(root)).isDirectory()) {
          throw new Error(`Selected project directory is missing from the worktree: ${root}`);
        }
        const state: WorktreeRuntimeState = {
          workspaceId: input.workspaceId,
          root,
          worktreeRoot: worktree.worktreePath,
          sourceRoot,
          lifecycle: "ready",
          lifecycleEnvironment: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            PASEO_SOURCE_CHECKOUT_PATH: sourceRoot,
            PASEO_ROOT_PATH: sourceRoot,
            PASEO_WORKTREE_PATH: worktree.worktreePath,
            PASEO_BRANCH_NAME: worktree.branchName,
          },
          branchName: worktree.branchName,
          ...(input.placement.relativeCwd ? { relativeCwd: input.placement.relativeCwd } : {}),
          ownsWorktree: true,
        };
        await states.write(state);
        return {
          state: publicState(state),
          placement: hostPlacement(root),
          materializedFreshContent: true,
        };
      } catch (error) {
        await deletePaseoWorktree({
          cwd: sourceRoot,
          worktreePath: worktree.worktreePath,
          teardownCwds: [],
          paseoHome: options.paseoHome,
          worktreesBaseRoot: options.worktreesRoot,
        });
        throw error;
      }
    },
    inspect,
    async spawn(input: WorkspaceDriverSpawnInput) {
      const root = (await requireReady(input.workspaceId)).root;
      return input.stdio.kind === "pty" ? spawnHostPty(root, input) : spawnHostProcess(root, input);
    },
    async observeGit(workspaceId, listener) {
      return options.hostGitObservations.observe((await requireReady(workspaceId)).root, listener);
    },
    async pause(workspaceId) {
      const state = await states.read(workspaceId);
      if (state?.lifecycle === "paused") return;
      if (!state) throw new Error(`Workspace runtime worktree is missing: ${workspaceId}`);
      const branchName = state.ownsWorktree === false ? undefined : await currentBranch(state);
      await states.write({
        ...state,
        lifecycle: "paused",
        ...(branchName
          ? {
              branchName,
              lifecycleEnvironment: {
                ...state.lifecycleEnvironment,
                PASEO_BRANCH_NAME: branchName,
              },
            }
          : {}),
      });
    },
    async releaseBacking(workspaceId) {
      const state = await states.read(workspaceId);
      if (!state) throw new Error(`Workspace runtime worktree is missing: ${workspaceId}`);
      if (state.lifecycle !== "paused") {
        throw new Error(`Workspace runtime worktree is not paused: ${workspaceId}`);
      }
      if (state.ownsWorktree === false) return;
      await deletePaseoWorktree({
        cwd: state.sourceRoot,
        worktreePath: state.worktreeRoot,
        teardownCwds: [],
        paseoHome: options.paseoHome,
        worktreesBaseRoot: options.worktreesRoot,
      });
    },
    async resume(workspaceId) {
      const current = await states.read(workspaceId);
      if (!current) throw new Error(`Workspace runtime worktree is missing: ${workspaceId}`);
      const rematerialized = await rematerializeOwnedWorktree(current, options);
      const state = { ...rematerialized, lifecycle: "ready" as const };
      await states.write(state);
      return { state: publicState(state), placement: hostPlacement(state.root) };
    },
    async destroy(workspaceId) {
      const state = await states.read(workspaceId);
      if (!state) return;
      if (state.ownsWorktree !== false) {
        await deletePaseoWorktree({
          cwd: state.sourceRoot,
          worktreePath: state.worktreeRoot,
          teardownCwds: [],
          paseoHome: options.paseoHome,
          worktreesBaseRoot: options.worktreesRoot,
        });
      }
      await states.remove(workspaceId);
    },
  };
}

function publicState(state: WorktreeRuntimeState): WorkspaceDriverState {
  return {
    workspaceId: state.workspaceId,
    lifecycle: state.lifecycle,
    lifecycleEnvironment: state.lifecycleEnvironment,
  };
}

function isWorktreeRuntimeState(
  value: unknown,
  workspaceId: string,
): value is WorktreeRuntimeState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<WorktreeRuntimeState>;
  return (
    state.workspaceId === workspaceId &&
    typeof state.root === "string" &&
    typeof state.sourceRoot === "string" &&
    typeof state.worktreeRoot === "string" &&
    (state.lifecycle === "ready" || state.lifecycle === "paused") &&
    !!state.lifecycleEnvironment &&
    typeof state.lifecycleEnvironment === "object" &&
    (state.branchName === undefined || typeof state.branchName === "string") &&
    (state.relativeCwd === undefined || typeof state.relativeCwd === "string") &&
    (state.ownsWorktree === undefined || typeof state.ownsWorktree === "boolean")
  );
}

async function currentBranch(state: WorktreeRuntimeState): Promise<string | undefined> {
  const { stdout } = await runGitCommand(["branch", "--show-current"], {
    cwd: state.worktreeRoot,
  });
  const branchName = stdout.trim();
  if (!branchName) {
    throw new Error(`Workspace runtime worktree has no current branch: ${state.workspaceId}`);
  }
  return branchName;
}

async function rematerializeOwnedWorktree(
  state: WorktreeRuntimeState,
  options: { paseoHome: string; worktreesRoot?: string },
): Promise<WorktreeRuntimeState> {
  const existing = await validateExistingWorktree(state);
  if (existing) return existing;
  if (state.ownsWorktree === false) {
    throw new Error(`Workspace runtime worktree is missing: ${state.workspaceId}`);
  }
  const branchName = state.branchName ?? state.lifecycleEnvironment.PASEO_BRANCH_NAME;
  if (!branchName) {
    throw new Error(`Workspace runtime worktree has no restorable branch: ${state.workspaceId}`);
  }
  try {
    if (!(await stat(state.sourceRoot)).isDirectory()) {
      throw new Error("The source repository needed to restore this worktree no longer exists.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("The source repository needed to restore this worktree no longer exists.", {
        cause: error,
      });
    }
    throw error;
  }
  await mkdir(path.dirname(state.worktreeRoot), { recursive: true });
  await runGitCommand(["worktree", "add", state.worktreeRoot, branchName], {
    cwd: state.sourceRoot,
    timeout: 120_000,
  });
  try {
    const relativeCwd = state.relativeCwd ?? path.relative(state.worktreeRoot, state.root);
    const root = await resolveRuntimeCwd(state.worktreeRoot, relativeCwd || undefined).catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("Selected project directory is missing from the worktree", {
            cause: error,
          });
        }
        throw error;
      },
    );
    return {
      ...state,
      root,
      branchName,
      ...(relativeCwd ? { relativeCwd } : {}),
      lifecycleEnvironment: {
        ...state.lifecycleEnvironment,
        PASEO_WORKTREE_PATH: state.worktreeRoot,
        PASEO_BRANCH_NAME: branchName,
      },
    };
  } catch (error) {
    await deletePaseoWorktree({
      cwd: state.sourceRoot,
      worktreePath: state.worktreeRoot,
      teardownCwds: [],
      paseoHome: options.paseoHome,
      worktreesBaseRoot: options.worktreesRoot,
    });
    throw error;
  }
}

async function validateExistingWorktree(
  state: WorktreeRuntimeState,
): Promise<WorktreeRuntimeState | null> {
  try {
    if (!(await stat(state.worktreeRoot)).isDirectory()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const { exitCode, stdout } = await runGitCommand(["rev-parse", "--show-toplevel"], {
    cwd: state.worktreeRoot,
    acceptExitCodes: [0, 128],
  });
  if (exitCode !== 0 || !createRealpathAwarePathMatcher(state.worktreeRoot)(stdout.trim())) {
    throw new Error(`Workspace runtime worktree path is occupied: ${state.worktreeRoot}`);
  }
  const branchName = await currentBranch(state);
  const expectedBranchName = state.branchName ?? state.lifecycleEnvironment.PASEO_BRANCH_NAME;
  if (!expectedBranchName || branchName !== expectedBranchName) {
    throw new Error(
      `Workspace runtime worktree branch changed: expected ${expectedBranchName ?? "unknown"}, received ${branchName}`,
    );
  }
  const relativeCwd = state.relativeCwd ?? path.relative(state.worktreeRoot, state.root);
  try {
    const root = await resolveRuntimeCwd(state.worktreeRoot, relativeCwd || undefined);
    if ((await stat(root)).isDirectory()) return { ...state, root };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  throw new Error(`Selected project directory is missing from the worktree: ${state.root}`);
}

function hostPlacement(root: string) {
  return { cwd: root, hostVisiblePath: root };
}

function toWorktreeSource(
  placement: Exclude<WorkspaceDriverCreateInput["placement"], { kind: "existing" }>,
): WorktreeSource {
  if (placement.kind === "resolved-worktree") return placement.source as WorktreeSource;
  if (placement.kind === "branch") {
    return {
      kind: "branch-off",
      baseBranch: placement.baseRef,
      branchName: placement.branchName,
    };
  }
  return { kind: "checkout-branch", branchName: placement.ref };
}
