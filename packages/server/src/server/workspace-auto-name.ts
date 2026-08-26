import type pino from "pino";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";

import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type { StructuredGenerationDaemonConfig } from "./agent/structured-generation-providers.js";
import {
  attemptFirstAgentBranchAutoName,
  type AttemptFirstAgentBranchAutoNameResult,
} from "./paseo-worktree-service.js";
import type { GitMutationService } from "./session/git-mutation/git-mutation-service.js";
import type { WorkspaceGitDirectory } from "./workspace-git-directory.js";
import {
  type PersistedWorkspaceRecord,
  resolveSelectedWorkspaceRuntimeId,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import {
  generateBranchNameFromFirstAgentContext,
  type GeneratedWorkspaceName,
  type GenerateBranchNameFromFirstAgentContextOptions,
} from "./worktree-branch-name-generator.js";

type WorkspaceNameGenerator = typeof generateBranchNameFromFirstAgentContext;

type CurrentSelection = GenerateBranchNameFromFirstAgentContextOptions["currentSelection"] | null;

interface WorkspaceAutoNameOptions {
  agentManager: AgentManager;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "update">;
  workspaceGitDirectory: Pick<WorkspaceGitDirectory, "bindRecord">;
  providerSnapshotManager: ProviderSnapshotManager;
  readDaemonConfig: () => StructuredGenerationDaemonConfig;
  gitMutation: Pick<GitMutationService, "notifyGitMutation">;
  emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  logger: pino.Logger;
  generateWorkspaceName?: WorkspaceNameGenerator;
}

interface ScheduleContext {
  currentSelection?: CurrentSelection;
}

export class WorkspaceAutoName {
  private readonly agentManager: AgentManager;
  private readonly workspaceRegistry: Pick<WorkspaceRegistry, "get" | "update">;
  private readonly workspaceGitDirectory: Pick<WorkspaceGitDirectory, "bindRecord">;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly readDaemonConfig: () => StructuredGenerationDaemonConfig;
  private readonly gitMutation: Pick<GitMutationService, "notifyGitMutation">;
  private readonly emitWorkspaceUpdateForCwd: (cwd: string) => Promise<void>;
  private readonly emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  private readonly logger: pino.Logger;
  private readonly generateWorkspaceName: WorkspaceNameGenerator;

  constructor(options: WorkspaceAutoNameOptions) {
    this.agentManager = options.agentManager;
    this.workspaceRegistry = options.workspaceRegistry;
    this.workspaceGitDirectory = options.workspaceGitDirectory;
    this.providerSnapshotManager = options.providerSnapshotManager;
    this.readDaemonConfig = options.readDaemonConfig;
    this.gitMutation = options.gitMutation;
    this.emitWorkspaceUpdateForCwd = options.emitWorkspaceUpdateForCwd;
    this.emitWorkspaceUpdateForWorkspaceId = options.emitWorkspaceUpdateForWorkspaceId;
    this.logger = options.logger;
    this.generateWorkspaceName =
      options.generateWorkspaceName ?? generateBranchNameFromFirstAgentContext;
  }

  scheduleForWorktree(
    input: {
      workspace: PersistedWorkspaceRecord;
      firstAgentContext: FirstAgentContext;
    },
    context: ScheduleContext = {},
  ): void {
    this.schedule(
      () =>
        this.maybeAutoNameWorkspaceBranchForFirstAgent({
          ...input,
          currentSelection: context.currentSelection ?? null,
        }),
      {
        cwd: input.workspace.cwd,
        message: "Failed to auto-name worktree branch",
      },
    );
  }

  scheduleForDirectory(
    input: {
      workspaceId: string;
      cwd: string;
      firstAgentContext: FirstAgentContext;
    },
    context: ScheduleContext = {},
  ): void {
    this.schedule(
      () =>
        this.maybeAutoNameDirectoryWorkspaceTitle({
          ...input,
          currentSelection: context.currentSelection ?? null,
        }),
      { cwd: input.cwd, message: "Failed to auto-name directory workspace title" },
    );
  }

  private async maybeAutoNameWorkspaceBranchForFirstAgent(input: {
    workspace: PersistedWorkspaceRecord;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
  }): Promise<void> {
    const selectedRuntimeId = resolveSelectedWorkspaceRuntimeId(input.workspace);
    const workspaceGit = selectedRuntimeId
      ? this.workspaceGitDirectory.bindRecord(input.workspace)
      : null;
    const worktreeRoot = selectedRuntimeId
      ? input.workspace.cwd
      : (input.workspace.worktreeRoot ?? input.workspace.cwd);
    const runtimePlaceholderBranch = selectedRuntimeId ? input.workspace.branch?.trim() : null;
    let generated: GeneratedWorkspaceName | null = null;
    const result: AttemptFirstAgentBranchAutoNameResult =
      selectedRuntimeId && !runtimePlaceholderBranch
        ? { attempted: false, renamed: false, branchName: null }
        : await attemptFirstAgentBranchAutoName({
            cwd: worktreeRoot,
            ...(workspaceGit && runtimePlaceholderBranch
              ? {
                  placeholderBranchName: runtimePlaceholderBranch,
                  getCurrentBranch: async () => (await workspaceGit.getCheckout()).currentBranch,
                  localBranchExists: async (_cwd, branch) => workspaceGit.hasLocalBranch(branch),
                  renameCurrentBranch: async (_cwd, branch) => workspaceGit.renameBranch(branch),
                }
              : {}),
            firstAgentContext: input.firstAgentContext,
            generateBranchNameFromContext: async ({ firstAgentContext }) => {
              const nextGenerated = await this.generateFromContext({
                workspaceId: input.workspace.workspaceId,
                cwd: input.workspace.cwd,
                firstAgentContext,
                currentSelection: input.currentSelection,
              });
              const current = await this.workspaceRegistry.get(input.workspace.workspaceId);
              if (!current || current.cwd !== input.workspace.cwd) return null;
              generated = nextGenerated;
              return nextGenerated?.branch ?? null;
            },
          });

    if (!generated) {
      generated = await this.generateFromContext({
        workspaceId: input.workspace.workspaceId,
        cwd: input.workspace.cwd,
        firstAgentContext: input.firstAgentContext,
        currentSelection: input.currentSelection,
      });
    }
    const generatedTitle = generated?.title ?? null;
    if (!generatedTitle) {
      return;
    }

    // K4: re-read from the registry before writing so any concurrent upsert
    // that happened between workspace creation and this async path is not clobbered.
    // When the first-agent rename changed the git branch too, persist that branch
    // alongside the title — both are this path's own fields.
    const updated = await this.applyGeneratedWorkspaceTitle(
      input.workspace.workspaceId,
      input.workspace.cwd,
      {
        title: generatedTitle,
        ...(result.renamed ? { branch: result.branchName } : {}),
        promptTitle: resolveFirstAgentPromptTitle(input.firstAgentContext),
      },
    );
    if (!updated) return;
    if (result.renamed) {
      if (workspaceGit) {
        await workspaceGit.getSnapshot({ force: true, reason: "rename-branch" });
      } else {
        await this.gitMutation.notifyGitMutation(worktreeRoot, "rename-branch");
      }
    }
    await this.emitWorkspaceUpdateForCwd(input.workspace.cwd);
  }

  private async maybeAutoNameDirectoryWorkspaceTitle(input: {
    workspaceId: string;
    cwd: string;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
  }): Promise<void> {
    const generated = await this.generateFromContext({
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      firstAgentContext: input.firstAgentContext,
      currentSelection: input.currentSelection,
    });
    const title = generated?.title ?? null;
    if (!title) {
      return;
    }
    // K4: applyGeneratedWorkspaceTitle re-reads from the registry before writing.
    // Directory workspaces have no branch — write only the title.
    const updated = await this.applyGeneratedWorkspaceTitle(input.workspaceId, input.cwd, {
      title,
      promptTitle: resolveFirstAgentPromptTitle(input.firstAgentContext),
    });
    if (!updated) return;
    await this.emitWorkspaceUpdateForWorkspaceId(input.workspaceId);
  }

  private async applyGeneratedWorkspaceTitle(
    workspaceId: string,
    expectedCwd: string,
    input: { title: string; branch?: string | null; promptTitle?: string | null },
  ): Promise<boolean> {
    const updated = await this.workspaceRegistry.update(workspaceId, (current) => {
      if (current.cwd !== expectedCwd) return current;
      let title = current.title;
      if (!title || (input.promptTitle && title === input.promptTitle)) {
        title = input.title;
      }
      return {
        ...current,
        title,
        ...(input.branch ? { branch: input.branch } : {}),
        updatedAt: new Date().toISOString(),
      };
    });
    return updated?.cwd === expectedCwd;
  }

  private async generateFromContext(input: {
    workspaceId: string;
    cwd: string;
    firstAgentContext: FirstAgentContext;
    currentSelection: CurrentSelection;
  }): Promise<GeneratedWorkspaceName | null> {
    const workspace = await this.workspaceRegistry.get(input.workspaceId);
    if (!workspace || workspace.cwd !== input.cwd) {
      return null;
    }
    const workspaceGit = this.workspaceGitDirectory.bindRecord(workspace);
    const workspaceId = resolveSelectedWorkspaceRuntimeId(workspace)
      ? workspace.workspaceId
      : undefined;
    return this.generateWorkspaceName({
      agentManager: this.agentManager,
      cwd: input.cwd,
      ...(workspaceId ? { workspaceId } : {}),
      workspaceGit,
      providerSnapshotManager: this.providerSnapshotManager,
      daemonConfig: this.readDaemonConfig(),
      currentSelection: input.currentSelection ?? undefined,
      firstAgentContext: input.firstAgentContext,
      logger: this.logger,
    });
  }

  private schedule(run: () => Promise<void>, context: { cwd: string; message: string }): void {
    setTimeout(() => {
      void run().catch((error) => {
        this.logger.warn({ err: error, cwd: context.cwd }, context.message);
      });
    }, 0);
  }
}
