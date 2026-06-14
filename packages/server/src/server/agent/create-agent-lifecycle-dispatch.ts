import { randomUUID } from "node:crypto";
import type pino from "pino";

import type { GitHubService } from "../../services/github-service.js";
import { isPaseoOwnedWorktreeCwd } from "../../utils/worktree.js";
import {
  type ActiveWorkspaceRef,
  archivePaseoWorktree,
} from "../paseo-worktree-archive-service.js";
import type {
  CreatePaseoWorktreeWorkflowFn,
  CreatePaseoWorktreeWorkflowResult,
} from "../worktree-session.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type {
  CreateAgentWorktreeTarget,
  FirstAgentContext,
  SessionOutboundMessage,
} from "../messages.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

interface CreateAgentLifecycleDispatchDependencies {
  paseoHome: string;
  worktreesRoot?: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  github: GitHubService;
  workspaceGitService: WorkspaceGitService;
  createPaseoWorktreeWorkflow: CreatePaseoWorktreeWorkflowFn;
  archiveAgentForClose: (agentId: string) => Promise<unknown>;
  resolveWorkspaceIdForCwd: (cwd: string) => Promise<string | null>;
  listActiveWorkspaces: () => Promise<ActiveWorkspaceRef[]>;
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
  emit: (message: SessionOutboundMessage) => void;
  emitAgentRemove: (agentId: string) => void;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  killTerminalsForWorkspace: (workspaceId: string) => Promise<void>;
  logger: pino.Logger;
}

export class CreateAgentLifecycleDispatch {
  private readonly autoArchiveAgentIds = new Set<string>();

  constructor(private readonly dependencies: CreateAgentLifecycleDispatchDependencies) {}

  async createWorktreeForRequest(input: {
    cwd: string;
    target: CreateAgentWorktreeTarget | undefined;
    firstAgentContext: FirstAgentContext;
    hasLegacyGitOptions: boolean;
  }): Promise<CreatePaseoWorktreeWorkflowResult | null> {
    if (input.target && input.hasLegacyGitOptions) {
      throw new Error("create_agent_request worktree cannot be combined with git options");
    }
    if (!input.target) {
      return null;
    }

    return this.createWorktreeForTarget(input.cwd, input.target, input.firstAgentContext);
  }

  registerAutoArchiveIfRequested(input: {
    autoArchive: boolean | undefined;
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }): void {
    if (input.autoArchive !== true) {
      return;
    }

    this.registerAutoArchiveOnTerminalState(input.agentId, {
      worktreePath: input.createdWorktree?.worktree.worktreePath ?? null,
      repoRoot: input.createdWorktree?.repoRoot ?? null,
    });
  }

  async cleanupCreatedWorktreeAfterFailedAgentCreate(input: {
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
    createdAgentId: string | null;
  }): Promise<void> {
    const { createdWorktree, createdAgentId } = input;
    if (!createdWorktree || createdAgentId) {
      return;
    }

    await this.archiveAutoCreatedWorktree({
      agentId: null,
      worktreePath: createdWorktree.worktree.worktreePath,
      repoRoot: createdWorktree.repoRoot,
    }).catch((archiveError) => {
      this.dependencies.logger.warn(
        {
          err: archiveError,
          worktreePath: createdWorktree.worktree.worktreePath,
        },
        "Failed to clean up worktree after create_agent_request failed",
      );
    });
  }

  private async createWorktreeForTarget(
    cwd: string,
    target: CreateAgentWorktreeTarget,
    firstAgentContext: FirstAgentContext,
  ): Promise<CreatePaseoWorktreeWorkflowResult> {
    const baseInput = {
      cwd,
      firstAgentContext,
      runSetup: false,
      paseoHome: this.dependencies.paseoHome,
      worktreesRoot: this.dependencies.worktreesRoot,
    } as const;

    switch (target.mode) {
      case "branch-off":
        return this.dependencies.createPaseoWorktreeWorkflow(
          {
            ...baseInput,
            worktreeSlug: target.newBranch,
            action: "branch-off",
            ...(target.base ? { refName: target.base } : {}),
          },
          target.base ? { resolveDefaultBranch: async () => target.base! } : undefined,
        );
      case "checkout-branch":
        return this.dependencies.createPaseoWorktreeWorkflow({
          ...baseInput,
          action: "checkout",
          refName: target.branch,
        });
      case "checkout-pr":
        return this.dependencies.createPaseoWorktreeWorkflow({
          ...baseInput,
          action: "checkout",
          githubPrNumber: target.prNumber,
        });
      default:
        throw new Error("Unsupported create_agent_request worktree target");
    }
  }

  private registerAutoArchiveOnTerminalState(
    agentId: string,
    options: { worktreePath: string | null; repoRoot: string | null },
  ): void {
    const unsubscribe = this.dependencies.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_stream") {
          return;
        }
        if (
          event.event.type !== "turn_completed" &&
          event.event.type !== "turn_failed" &&
          event.event.type !== "turn_canceled"
        ) {
          return;
        }
        unsubscribe();
        void this.autoArchiveAgentOnce(agentId, options);
      },
      { agentId, replayState: false },
    );
  }

  private async autoArchiveAgentOnce(
    agentId: string,
    options: { worktreePath: string | null; repoRoot: string | null },
  ): Promise<void> {
    if (this.autoArchiveAgentIds.has(agentId)) {
      return;
    }
    this.autoArchiveAgentIds.add(agentId);

    try {
      if (options.worktreePath) {
        await this.archiveAutoCreatedWorktree({
          agentId,
          worktreePath: options.worktreePath,
          repoRoot: options.repoRoot,
        });
        return;
      }

      await this.dependencies.archiveAgentForClose(agentId);
    } catch (error) {
      this.dependencies.logger.warn({ err: error, agentId }, "Failed to auto-archive agent");
    }
  }

  private async archiveAutoCreatedWorktree(options: {
    agentId: string | null;
    worktreePath: string;
    repoRoot: string | null;
  }): Promise<void> {
    const ownership = await isPaseoOwnedWorktreeCwd(options.worktreePath, {
      paseoHome: this.dependencies.paseoHome,
      worktreesRoot: this.dependencies.worktreesRoot,
    });
    if (!ownership.allowed) {
      throw new Error("Auto-created worktree is not a Paseo-owned worktree");
    }

    await archivePaseoWorktree(
      {
        paseoHome: this.dependencies.paseoHome,
        worktreesRoot: this.dependencies.worktreesRoot,
        github: this.dependencies.github,
        workspaceGitService: this.dependencies.workspaceGitService,
        agentManager: this.dependencies.agentManager,
        agentStorage: this.dependencies.agentStorage,
        resolveWorkspaceIdForCwd: this.dependencies.resolveWorkspaceIdForCwd,
        listActiveWorkspaces: this.dependencies.listActiveWorkspaces,
        archiveWorkspaceRecord: this.dependencies.archiveWorkspaceRecord,
        emitWorkspaceUpdatesForWorkspaceIds: this.dependencies.emitWorkspaceUpdatesForWorkspaceIds,
        markWorkspaceArchiving: this.dependencies.markWorkspaceArchiving,
        clearWorkspaceArchiving: this.dependencies.clearWorkspaceArchiving,
        killTerminalsForWorkspace: this.dependencies.killTerminalsForWorkspace,
        sessionLogger: this.dependencies.logger,
      },
      {
        targetPath: options.worktreePath,
        repoRoot: options.repoRoot ?? ownership.repoRoot ?? null,
        worktreesRoot: ownership.worktreeRoot,
        worktreesBaseRoot: this.dependencies.worktreesRoot,
        requestId: randomUUID(),
      },
    );

    if (options.agentId) {
      this.dependencies.emitAgentRemove(options.agentId);
    }
  }
}
