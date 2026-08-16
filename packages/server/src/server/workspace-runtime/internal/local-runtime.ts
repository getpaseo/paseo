import { stat } from "node:fs/promises";
import path from "node:path";

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

interface LocalRuntimeState {
  workspaceId: string;
  root: string;
  lifecycle: "ready" | "paused";
  compatibilityCwd?: string;
}

export function createLocalRuntime(
  paseoHome: string,
  hostGitObservations: HostGitObservationOwner,
): WorkspaceRuntimeDriver {
  const states = createRuntimeStateStore(paseoHome, "local", isLocalRuntimeState);

  async function inspect(workspaceId: string): Promise<WorkspaceDriverInspection> {
    const state = (await states.read(workspaceId)) as LocalRuntimeState | null;
    if (!state) return { status: "missing" };
    try {
      if (!(await stat(state.root)).isDirectory()) return { status: "missing" };
      return {
        status: state.lifecycle,
        state: publicState(state),
        placement: hostPlacement(state.compatibilityCwd ?? state.root),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "error", message: String(error) };
    }
  }

  async function requireReady(workspaceId: string): Promise<LocalRuntimeState> {
    const state = await states.read(workspaceId);
    if (!state || state.lifecycle !== "ready") {
      throw new Error(
        `Workspace runtime local is ${state?.lifecycle ?? "missing"}: ${workspaceId}`,
      );
    }
    return state;
  }

  return {
    id: "local",
    requiresGitProject: false,
    workspaceHelper: hostWorkspaceHelper,
    scriptTerminal: { kind: "persistent-shell" },
    provider: {
      environment: "inherit-sanitized-host",
      sharedHostProviders: new Set(["opencode"]),
    },
    async create(input: WorkspaceDriverCreateInput) {
      const existing = await inspect(input.workspaceId);
      if (existing.status === "ready" || existing.status === "paused") {
        return { ...existing, materializedFreshContent: false };
      }
      if (input.project.source.kind !== "host-directory" || input.placement.kind !== "existing") {
        throw new Error("The local runtime adopts an existing host directory");
      }
      const sourceCwd = path.resolve(input.project.source.path);
      const compatibilityCwd = path.resolve(sourceCwd, input.placement.relativeCwd ?? ".");
      const root = await resolveRuntimeCwd(sourceCwd, input.placement.relativeCwd);
      if (!(await stat(root)).isDirectory()) throw new Error(`Directory not found: ${root}`);
      const state: LocalRuntimeState = {
        workspaceId: input.workspaceId,
        root,
        lifecycle: "ready",
        compatibilityCwd,
      };
      await states.write(state);
      return {
        state: publicState(state),
        placement: hostPlacement(compatibilityCwd),
        materializedFreshContent: false,
      };
    },
    inspect,
    async spawn(input: WorkspaceDriverSpawnInput) {
      const root = (await requireReady(input.workspaceId)).root;
      return input.stdio.kind === "pty" ? spawnHostPty(root, input) : spawnHostProcess(root, input);
    },
    async observeGit(workspaceId, listener) {
      return hostGitObservations.observe((await requireReady(workspaceId)).root, listener);
    },
    async pause(workspaceId) {
      const state = await states.read(workspaceId);
      if (state?.lifecycle === "paused") return;
      if (!state) throw new Error(`Workspace runtime local is missing: ${workspaceId}`);
      await states.write({ ...state, lifecycle: "paused" });
    },
    async resume(workspaceId) {
      const current = await states.read(workspaceId);
      if (!current) throw new Error(`Workspace runtime local is missing: ${workspaceId}`);
      const state = { ...current, lifecycle: "ready" as const };
      await states.write(state);
      return {
        state: publicState(state),
        placement: hostPlacement(state.compatibilityCwd ?? state.root),
      };
    },
    async destroy(workspaceId) {
      await states.remove(workspaceId);
    },
  };
}

function publicState(state: LocalRuntimeState): WorkspaceDriverState {
  return { workspaceId: state.workspaceId, lifecycle: state.lifecycle };
}

function isLocalRuntimeState(value: unknown, workspaceId: string): value is LocalRuntimeState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<LocalRuntimeState>;
  return (
    state.workspaceId === workspaceId &&
    typeof state.root === "string" &&
    (state.lifecycle === "ready" || state.lifecycle === "paused") &&
    (state.compatibilityCwd === undefined || typeof state.compatibilityCwd === "string")
  );
}

function hostPlacement(root: string) {
  return { cwd: root, hostVisiblePath: root };
}
