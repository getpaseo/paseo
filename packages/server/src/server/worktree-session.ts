import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { v4 as uuidv4 } from "uuid";

import type { AgentSessionConfig } from "./agent/agent-sdk-types.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  type GitSetupOptions,
  type ProjectPlacementPayload,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type WorkspaceDescriptorPayload,
} from "./messages.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "./workspace-registry.js";
import { normalizeWorkspaceId as normalizePersistedWorkspaceId } from "./workspace-registry-model.js";
import { createAgentWorktree } from "./worktree-bootstrap.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import {
  getCheckoutStatusLite,
  resolveRepositoryDefaultBranch,
} from "../utils/checkout-git.js";
import { expandTilde } from "../utils/path.js";
import {
  computeWorktreePath,
  deletePaseoWorktree,
  getWorktreeSetupCommands,
  isPaseoOwnedWorktreeCwd,
  listPaseoWorktrees,
  resolvePaseoWorktreeRootForCwd,
  resolveWorktreeRuntimeEnv,
  slugify,
  validateBranchSlug,
  type WorktreeConfig,
} from "../utils/worktree.js";
import { READ_ONLY_GIT_ENV, toCheckoutError } from "./checkout-git-utils.js";

const execAsync = promisify(exec);
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9._\/-]+$/;

export type NormalizedGitOptions = {
  baseBranch?: string;
  createNewBranch: boolean;
  newBranchName?: string;
  createWorktree: boolean;
  worktreeSlug?: string;
};

type EmitSessionMessage = (message: SessionOutboundMessage) => void;

type BuildAgentSessionConfigDependencies = {
  paseoHome?: string;
  sessionLogger: Logger;
  checkoutExistingBranch: (cwd: string, branch: string) => Promise<void>;
  createBranchFromBase: (params: {
    cwd: string;
    baseBranch: string;
    newBranchName: string;
  }) => Promise<void>;
};

type ArchivePaseoWorktreeDependencies = {
  paseoHome?: string;
  agentManager: Pick<AgentManager, "listAgents" | "closeAgent">;
  agentStorage: Pick<AgentStorage, "list" | "remove">;
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
  emit: EmitSessionMessage;
  emitWorkspaceUpdatesForCwds: (cwds: Iterable<string>) => Promise<void>;
  isPathWithinRoot: (rootPath: string, candidatePath: string) => boolean;
  killTerminalsUnderPath: (rootPath: string) => Promise<void>;
};

type RegisterPendingWorktreeWorkspaceDependencies = {
  buildPersistedProjectRecord: (input: {
    workspaceId: string;
    placement: ProjectPlacementPayload;
    createdAt: string;
    updatedAt: string;
  }) => PersistedProjectRecord;
  buildPersistedWorkspaceRecord: (input: {
    workspaceId: string;
    placement: ProjectPlacementPayload;
    createdAt: string;
    updatedAt: string;
  }) => PersistedWorkspaceRecord;
  buildProjectPlacement: (cwd: string) => Promise<ProjectPlacementPayload>;
  projectRegistry: Pick<ProjectRegistry, "get" | "upsert">;
  syncWorkspaceGitWatchTarget: (
    cwd: string,
    options: { isGit: boolean },
  ) => Promise<void>;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "upsert">;
  archiveProjectRecordIfEmpty: (projectId: string, archivedAt: string) => Promise<void>;
};

type CreatePaseoWorktreeInBackgroundDependencies = {
  paseoHome?: string;
  emitWorkspaceUpdateForCwd: (
    cwd: string,
    options?: { dedupeGitState?: boolean },
  ) => Promise<void>;
  sessionLogger: Logger;
  terminalManager: TerminalManager | null;
};

type HandleCreatePaseoWorktreeRequestDependencies = {
  paseoHome?: string;
  describeWorkspaceRecord: (
    workspace: PersistedWorkspaceRecord,
  ) => Promise<WorkspaceDescriptorPayload>;
  emit: EmitSessionMessage;
  registerPendingWorktreeWorkspace: (options: {
    repoRoot: string;
    worktreePath: string;
    branchName: string;
  }) => Promise<PersistedWorkspaceRecord>;
  sessionLogger: Logger;
  createPaseoWorktreeInBackground: (options: {
    requestCwd: string;
    repoRoot: string;
    baseBranch: string;
    slug: string;
    worktreePath: string;
  }) => Promise<void>;
};

type KillTerminalsUnderPathDependencies = {
  isPathWithinRoot: (rootPath: string, candidatePath: string) => boolean;
  killTrackedTerminal: (terminalId: string, options?: { emitExit: boolean }) => void;
  sessionLogger: Logger;
  terminalManager: TerminalManager | null;
};

export async function buildAgentSessionConfig(
  dependencies: BuildAgentSessionConfigDependencies,
  config: AgentSessionConfig,
  gitOptions?: GitSetupOptions,
  legacyWorktreeName?: string,
  _labels?: Record<string, string>,
): Promise<{ sessionConfig: AgentSessionConfig; worktreeConfig?: WorktreeConfig }> {
  let cwd = expandTilde(config.cwd);
  const normalized = normalizeGitOptions(gitOptions, legacyWorktreeName);
  let worktreeConfig: WorktreeConfig | undefined;

  if (!normalized) {
    return {
      sessionConfig: {
        ...config,
        cwd,
      },
    };
  }

  if (normalized.createWorktree) {
    let targetBranch: string;

    if (normalized.createNewBranch) {
      targetBranch = normalized.newBranchName!;
    } else {
      const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        env: READ_ONLY_GIT_ENV,
      });
      targetBranch = stdout.trim();
    }

    if (!targetBranch) {
      throw new Error("A branch name is required when creating a worktree.");
    }

    dependencies.sessionLogger.info(
      { worktreeSlug: normalized.worktreeSlug ?? targetBranch, branch: targetBranch },
      `Creating worktree '${normalized.worktreeSlug ?? targetBranch}' for branch ${targetBranch}`,
    );

    const baseBranch =
      normalized.baseBranch ?? (await resolveGitCreateBaseBranch(cwd, dependencies.paseoHome));
    const createdWorktree = await createAgentWorktree({
      branchName: targetBranch,
      cwd,
      baseBranch,
      worktreeSlug: normalized.worktreeSlug ?? targetBranch,
      paseoHome: dependencies.paseoHome,
    });
    cwd = createdWorktree.worktreePath;
    worktreeConfig = createdWorktree;
  } else if (normalized.createNewBranch) {
    const baseBranch =
      normalized.baseBranch ?? (await resolveGitCreateBaseBranch(cwd, dependencies.paseoHome));
    await dependencies.createBranchFromBase({
      cwd,
      baseBranch,
      newBranchName: normalized.newBranchName!,
    });
  } else if (normalized.baseBranch) {
    await dependencies.checkoutExistingBranch(cwd, normalized.baseBranch);
  }

  return {
    sessionConfig: {
      ...config,
      cwd,
    },
    worktreeConfig,
  };
}

export function normalizeGitOptions(
  gitOptions?: GitSetupOptions,
  legacyWorktreeName?: string,
): NormalizedGitOptions | null {
  const fallbackOptions: GitSetupOptions | undefined = legacyWorktreeName
    ? {
        createWorktree: true,
        createNewBranch: true,
        newBranchName: legacyWorktreeName,
        worktreeSlug: legacyWorktreeName,
      }
    : undefined;

  const merged = gitOptions ?? fallbackOptions;
  if (!merged) {
    return null;
  }

  const baseBranch = merged.baseBranch?.trim() || undefined;
  const createWorktree = Boolean(merged.createWorktree);
  const createNewBranch = Boolean(merged.createNewBranch);
  const normalizedBranchName = merged.newBranchName ? slugify(merged.newBranchName) : undefined;
  const normalizedWorktreeSlug = merged.worktreeSlug
    ? slugify(merged.worktreeSlug)
    : normalizedBranchName;

  if (!createWorktree && !createNewBranch && !baseBranch) {
    return null;
  }

  if (baseBranch) {
    assertSafeGitRef(baseBranch, "base branch");
  }

  if (createNewBranch) {
    if (!normalizedBranchName) {
      throw new Error("New branch name is required");
    }
    const validation = validateBranchSlug(normalizedBranchName);
    if (!validation.valid) {
      throw new Error(`Invalid branch name: ${validation.error}`);
    }
  }

  if (normalizedWorktreeSlug) {
    const validation = validateBranchSlug(normalizedWorktreeSlug);
    if (!validation.valid) {
      throw new Error(`Invalid worktree name: ${validation.error}`);
    }
  }

  return {
    baseBranch,
    createNewBranch,
    newBranchName: normalizedBranchName,
    createWorktree,
    worktreeSlug: normalizedWorktreeSlug,
  };
}

export function assertSafeGitRef(ref: string, label: string): void {
  if (!SAFE_GIT_REF_PATTERN.test(ref) || ref.includes("..") || ref.includes("@{")) {
    throw new Error(`Invalid ${label}: ${ref}`);
  }
}

export async function resolveGitCreateBaseBranch(
  cwd: string,
  paseoHome?: string,
): Promise<string> {
  const checkout = await getCheckoutStatusLite(cwd, { paseoHome });
  if (!checkout.isGit) {
    throw new Error("Cannot create a worktree outside a git repository");
  }

  const repoRoot = checkout.isPaseoOwnedWorktree ? checkout.mainRepoRoot : cwd;
  const baseBranch = await resolveRepositoryDefaultBranch(repoRoot);
  if (!baseBranch) {
    throw new Error("Unable to resolve repository default branch");
  }
  return baseBranch;
}

export async function handlePaseoWorktreeListRequest(
  dependencies: { emit: EmitSessionMessage; paseoHome?: string },
  msg: Extract<SessionInboundMessage, { type: "paseo_worktree_list_request" }>,
): Promise<void> {
  const { requestId } = msg;
  const cwd = msg.repoRoot ?? msg.cwd;
  if (!cwd) {
    dependencies.emit({
      type: "paseo_worktree_list_response",
      payload: {
        worktrees: [],
        error: { code: "UNKNOWN", message: "cwd or repoRoot is required" },
        requestId,
      },
    });
    return;
  }

  try {
    const worktrees = await listPaseoWorktrees({ cwd, paseoHome: dependencies.paseoHome });
    dependencies.emit({
      type: "paseo_worktree_list_response",
      payload: {
        worktrees: worktrees.map((entry) => ({
          worktreePath: entry.path,
          createdAt: entry.createdAt,
          branchName: entry.branchName ?? null,
          head: entry.head ?? null,
        })),
        error: null,
        requestId,
      },
    });
  } catch (error) {
    dependencies.emit({
      type: "paseo_worktree_list_response",
      payload: {
        worktrees: [],
        error: toCheckoutError(error),
        requestId,
      },
    });
  }
}

export async function archivePaseoWorktree(
  dependencies: ArchivePaseoWorktreeDependencies,
  options: {
    targetPath: string;
    repoRoot: string;
    requestId: string;
  },
): Promise<string[]> {
  let targetPath = options.targetPath;
  const resolvedWorktree = await resolvePaseoWorktreeRootForCwd(targetPath, {
    paseoHome: dependencies.paseoHome,
  });
  if (resolvedWorktree) {
    targetPath = resolvedWorktree.worktreePath;
  }

  const removedAgents = new Set<string>();
  const affectedWorkspaceCwds = new Set<string>([targetPath]);
  const affectedWorkspaceIds = new Set<string>([normalizePersistedWorkspaceId(targetPath)]);
  const agents = dependencies.agentManager.listAgents();
  for (const agent of agents) {
    if (!dependencies.isPathWithinRoot(targetPath, agent.cwd)) {
      continue;
    }

    removedAgents.add(agent.id);
    affectedWorkspaceCwds.add(agent.cwd);
    affectedWorkspaceIds.add(normalizePersistedWorkspaceId(agent.cwd));
    try {
      await dependencies.agentManager.closeAgent(agent.id);
    } catch {
      // ignore cleanup errors
    }
    try {
      await dependencies.agentStorage.remove(agent.id);
    } catch {
      // ignore cleanup errors
    }
  }

  const registryRecords = await dependencies.agentStorage.list();
  for (const record of registryRecords) {
    if (!dependencies.isPathWithinRoot(targetPath, record.cwd)) {
      continue;
    }

    removedAgents.add(record.id);
    affectedWorkspaceCwds.add(record.cwd);
    affectedWorkspaceIds.add(normalizePersistedWorkspaceId(record.cwd));
    try {
      await dependencies.agentStorage.remove(record.id);
    } catch {
      // ignore cleanup errors
    }
  }

  await dependencies.killTerminalsUnderPath(targetPath);

  await deletePaseoWorktree({
    cwd: options.repoRoot,
    worktreePath: targetPath,
    paseoHome: dependencies.paseoHome,
  });

  for (const workspaceId of affectedWorkspaceIds) {
    await dependencies.archiveWorkspaceRecord(workspaceId);
  }

  for (const agentId of removedAgents) {
    dependencies.emit({
      type: "agent_deleted",
      payload: {
        agentId,
        requestId: options.requestId,
      },
    });
  }

  await dependencies.emitWorkspaceUpdatesForCwds(affectedWorkspaceCwds);

  return Array.from(removedAgents);
}

export async function handlePaseoWorktreeArchiveRequest(
  dependencies: Omit<ArchivePaseoWorktreeDependencies, "emitWorkspaceUpdatesForCwds"> & {
    emit: EmitSessionMessage;
    emitWorkspaceUpdatesForCwds: (cwds: Iterable<string>) => Promise<void>;
  },
  msg: Extract<SessionInboundMessage, { type: "paseo_worktree_archive_request" }>,
): Promise<void> {
  const { requestId } = msg;
  let targetPath = msg.worktreePath;
  let repoRoot = msg.repoRoot ?? null;

  try {
    if (!targetPath) {
      if (!repoRoot || !msg.branchName) {
        throw new Error("worktreePath or repoRoot+branchName is required");
      }
      const worktrees = await listPaseoWorktrees({
        cwd: repoRoot,
        paseoHome: dependencies.paseoHome,
      });
      const match = worktrees.find((entry) => entry.branchName === msg.branchName);
      if (!match) {
        throw new Error(`Paseo worktree not found for branch ${msg.branchName}`);
      }
      targetPath = match.path;
    }

    const ownership = await isPaseoOwnedWorktreeCwd(targetPath, {
      paseoHome: dependencies.paseoHome,
    });
    if (!ownership.allowed) {
      dependencies.emit({
        type: "paseo_worktree_archive_response",
        payload: {
          success: false,
          removedAgents: [],
          error: {
            code: "NOT_ALLOWED",
            message: "Worktree is not a Paseo-owned worktree",
          },
          requestId,
        },
      });
      return;
    }

    repoRoot = ownership.repoRoot ?? repoRoot ?? null;
    if (!repoRoot) {
      throw new Error("Unable to resolve repo root for worktree");
    }

    const removedAgents = await archivePaseoWorktree(dependencies, {
      targetPath,
      repoRoot,
      requestId,
    });

    dependencies.emit({
      type: "paseo_worktree_archive_response",
      payload: {
        success: true,
        removedAgents,
        error: null,
        requestId,
      },
    });
  } catch (error) {
    dependencies.emit({
      type: "paseo_worktree_archive_response",
      payload: {
        success: false,
        removedAgents: [],
        error: toCheckoutError(error),
        requestId,
      },
    });
  }
}

export async function registerPendingWorktreeWorkspace(
  dependencies: RegisterPendingWorktreeWorkspaceDependencies,
  options: {
    repoRoot: string;
    worktreePath: string;
    branchName: string;
  },
): Promise<PersistedWorkspaceRecord> {
  const workspaceId = normalizePersistedWorkspaceId(options.worktreePath);
  const basePlacement = await dependencies.buildProjectPlacement(options.repoRoot);
  const placement: ProjectPlacementPayload = {
    ...basePlacement,
    checkout: {
      cwd: workspaceId,
      isGit: true,
      currentBranch: options.branchName,
      remoteUrl: basePlacement.checkout.remoteUrl,
      worktreeRoot: options.worktreePath,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: options.repoRoot,
    },
  };
  const now = new Date().toISOString();
  const existingWorkspace = await dependencies.workspaceRegistry.get(workspaceId);
  const existingProject = await dependencies.projectRegistry.get(placement.projectKey);
  const nextProjectRecord = dependencies.buildPersistedProjectRecord({
    workspaceId,
    placement,
    createdAt: existingProject?.createdAt ?? now,
    updatedAt: now,
  });
  const nextWorkspaceRecord = dependencies.buildPersistedWorkspaceRecord({
    workspaceId,
    placement,
    createdAt: existingWorkspace?.createdAt ?? now,
    updatedAt: now,
  });

  await dependencies.projectRegistry.upsert(nextProjectRecord);
  await dependencies.workspaceRegistry.upsert(nextWorkspaceRecord);
  await dependencies.syncWorkspaceGitWatchTarget(workspaceId, {
    isGit: placement.checkout.isGit,
  });

  if (
    existingWorkspace &&
    !existingWorkspace.archivedAt &&
    existingWorkspace.projectId !== nextWorkspaceRecord.projectId
  ) {
    await dependencies.archiveProjectRecordIfEmpty(existingWorkspace.projectId, now);
  }

  return nextWorkspaceRecord;
}

export async function handleCreatePaseoWorktreeRequest(
  dependencies: HandleCreatePaseoWorktreeRequestDependencies,
  request: Extract<SessionInboundMessage, { type: "create_paseo_worktree_request" }>,
): Promise<void> {
  try {
    const checkout = await getCheckoutStatusLite(request.cwd, {
      paseoHome: dependencies.paseoHome,
    });
    if (!checkout.isGit) {
      throw new Error("Create worktree requires a git repository");
    }

    const repoRoot = checkout.isPaseoOwnedWorktree ? checkout.mainRepoRoot : request.cwd;
    const baseBranch = await resolveRepositoryDefaultBranch(repoRoot);
    if (!baseBranch) {
      throw new Error("Unable to resolve repository default branch");
    }

    const normalizedSlug = request.worktreeSlug ? slugify(request.worktreeSlug) : uuidv4();
    const validation = validateBranchSlug(normalizedSlug);
    if (!validation.valid) {
      throw new Error(`Invalid worktree name: ${validation.error}`);
    }

    const worktreePath = await computeWorktreePath(repoRoot, normalizedSlug, dependencies.paseoHome);
    const workspace = await dependencies.registerPendingWorktreeWorkspace({
      repoRoot,
      worktreePath,
      branchName: normalizedSlug,
    });
    const descriptor = await dependencies.describeWorkspaceRecord(workspace);
    dependencies.emit({
      type: "create_paseo_worktree_response",
      payload: {
        workspace: descriptor,
        error: null,
        setupTerminalId: null,
        requestId: request.requestId,
      },
    });

    void dependencies.createPaseoWorktreeInBackground({
      requestCwd: request.cwd,
      repoRoot,
      baseBranch,
      slug: normalizedSlug,
      worktreePath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create worktree";
    dependencies.sessionLogger.error(
      { err: error, cwd: request.cwd, worktreeSlug: request.worktreeSlug },
      "Failed to create worktree",
    );
    dependencies.emit({
      type: "create_paseo_worktree_response",
      payload: {
        workspace: null,
        error: message,
        setupTerminalId: null,
        requestId: request.requestId,
      },
    });
  }
}

export async function createPaseoWorktreeInBackground(
  dependencies: CreatePaseoWorktreeInBackgroundDependencies,
  options: {
    requestCwd: string;
    repoRoot: string;
    baseBranch: string;
    slug: string;
    worktreePath: string;
  },
): Promise<void> {
  let setupTerminalId: string | null = null;

  try {
    await createAgentWorktree({
      cwd: options.repoRoot,
      branchName: options.slug,
      baseBranch: options.baseBranch,
      worktreeSlug: options.slug,
      paseoHome: dependencies.paseoHome,
    });

    const setupCommands = getWorktreeSetupCommands(options.worktreePath);
    if (setupCommands.length > 0 && dependencies.terminalManager) {
      const runtimeEnv = await resolveWorktreeRuntimeEnv({
        worktreePath: options.worktreePath,
        branchName: options.slug,
        repoRootPath: options.repoRoot,
      });
      dependencies.terminalManager.registerCwdEnv({
        cwd: options.worktreePath,
        env: runtimeEnv,
      });
      const terminal = await dependencies.terminalManager.createTerminal({
        cwd: options.worktreePath,
        name: `setup-${options.slug}`,
        env: runtimeEnv,
      });
      setupTerminalId = terminal.id;

      for (const command of setupCommands) {
        terminal.send({
          type: "input",
          data: `${command}\r`,
        });
      }
    }
  } catch (error) {
    dependencies.sessionLogger.error(
      {
        err: error,
        cwd: options.requestCwd,
        repoRoot: options.repoRoot,
        worktreeSlug: options.slug,
        worktreePath: options.worktreePath,
        setupTerminalId,
      },
      "Background worktree creation failed",
    );
  } finally {
    await dependencies.emitWorkspaceUpdateForCwd(options.worktreePath);
  }
}

export async function killTerminalsUnderPath(
  dependencies: KillTerminalsUnderPathDependencies,
  rootPath: string,
): Promise<void> {
  if (!dependencies.terminalManager) {
    return;
  }

  const cleanupErrors: Array<{ cwd: string; message: string }> = [];
  const terminalDirectories = [...dependencies.terminalManager.listDirectories()];
  for (const terminalCwd of terminalDirectories) {
    if (!dependencies.isPathWithinRoot(rootPath, terminalCwd)) {
      continue;
    }

    try {
      const terminals = await dependencies.terminalManager.getTerminals(terminalCwd);
      for (const terminal of [...terminals]) {
        dependencies.killTrackedTerminal(terminal.id, { emitExit: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cleanupErrors.push({ cwd: terminalCwd, message });
      dependencies.sessionLogger.warn(
        { err: error, cwd: terminalCwd },
        "Failed to clean up worktree terminals during archive",
      );
    }
  }

  if (cleanupErrors.length > 0) {
    const details = cleanupErrors.map((entry) => `${entry.cwd}: ${entry.message}`).join("; ");
    throw new Error(`Failed to clean up worktree terminals during archive (${details})`);
  }
}
