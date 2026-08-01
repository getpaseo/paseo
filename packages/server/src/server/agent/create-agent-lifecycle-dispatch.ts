import { randomUUID } from "node:crypto";
import type pino from "pino";

import type { ForgeService } from "../../services/forge-service.js";
import { isPaseoOwnedWorktreeCwd } from "../../utils/worktree.js";
import {
  archiveByScope,
  requireArchiveCleanupComplete,
  type ActiveWorkspaceRef,
} from "../workspace-archive-service.js";
import type {
  CreatePaseoWorktreeWorkflowFn,
  CreatePaseoWorktreeWorkflowResult,
} from "../worktree-session.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type {
  CreateAgentWorktreeTarget,
  FirstAgentContext,
  SessionOutboundMessage,
} from "../messages.js";
import type { AgentManager, AgentSubscriber, SubscribeOptions } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

interface CreateAgentLifecycleDispatchDependencies {
  paseoHome: string;
  worktreesRoot?: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  github: ForgeService;
  workspaceGitService: WorkspaceGitService;
  createPaseoWorktreeWorkflow: CreatePaseoWorktreeWorkflowFn;
  archiveAgentForClose: (agentId: string) => Promise<unknown>;
  findWorkspaceIdForCwd: (cwd: string) => Promise<string | null>;
  listActiveWorkspaces: () => Promise<ActiveWorkspaceRef[]>;
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list" | "update">;
  emit: (message: SessionOutboundMessage) => void;
  emitAgentRemove: (agentId: string) => void;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  killTerminalsForWorkspace: (workspaceId: string) => Promise<void>;
  logger: pino.Logger;
}

export interface LifecycleRegistration {
  cancel(): Promise<void>;
}

interface AgentLifecycleEvents {
  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void;
}

const inactiveRegistration: LifecycleRegistration = { cancel: async () => undefined };

type AutoArchiveTarget =
  | { kind: "agent-only" }
  | { kind: "created-worktree"; result: CreatePaseoWorktreeWorkflowResult };

export class CreateAgentLifecycleDispatch {
  private readonly autoArchiveTasks = new Map<string, Promise<void>>();

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
  }): LifecycleRegistration {
    if (input.autoArchive !== true) {
      return inactiveRegistration;
    }

    return this.registerAutoArchiveOnTerminalState(
      input.agentId,
      toAutoArchiveTarget(input.createdWorktree),
    );
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
      createdWorktree,
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
    target: AutoArchiveTarget,
  ): LifecycleRegistration {
    return registerAgentAutoArchive({
      agentManager: this.dependencies.agentManager,
      agentId,
      archive: () => this.autoArchiveAgentOnce(agentId, target),
    });
  }

  private async autoArchiveAgentOnce(agentId: string, target: AutoArchiveTarget): Promise<void> {
    const existingTask = this.autoArchiveTasks.get(agentId);
    if (existingTask) return existingTask;

    const archiveTask = this.runAutoArchiveAgent(agentId, target);
    this.autoArchiveTasks.set(agentId, archiveTask);
    try {
      await archiveTask;
    } catch (error) {
      this.dependencies.logger.warn({ err: error, agentId }, "Failed to auto-archive agent");
      throw error;
    } finally {
      if (this.autoArchiveTasks.get(agentId) === archiveTask) {
        this.autoArchiveTasks.delete(agentId);
      }
    }
  }

  private async runAutoArchiveAgent(agentId: string, target: AutoArchiveTarget): Promise<void> {
    if (target.kind === "created-worktree") {
      await this.archiveAutoCreatedWorktree({
        agentId,
        createdWorktree: target.result,
      });
      return;
    }

    await this.dependencies.archiveAgentForClose(agentId);
  }

  private async archiveAutoCreatedWorktree(options: {
    agentId: string | null;
    createdWorktree: CreatePaseoWorktreeWorkflowResult;
  }): Promise<void> {
    const { createdWorktree } = options;
    const worktreePath = createdWorktree.worktree.worktreePath;
    const ownership = await isPaseoOwnedWorktreeCwd(worktreePath, {
      paseoHome: this.dependencies.paseoHome,
      worktreesRoot: this.dependencies.worktreesRoot,
    });
    if (!ownership.allowed) {
      throw new Error("Auto-created worktree is not a Paseo-owned worktree");
    }

    const archiveResult = await archiveByScope(
      {
        paseoHome: this.dependencies.paseoHome,
        paseoWorktreesBaseRoot: this.dependencies.worktreesRoot,
        github: this.dependencies.github,
        workspaceGitService: this.dependencies.workspaceGitService,
        agentManager: this.dependencies.agentManager,
        agentStorage: this.dependencies.agentStorage,
        findWorkspaceIdForCwd: this.dependencies.findWorkspaceIdForCwd,
        listActiveWorkspaces: this.dependencies.listActiveWorkspaces,
        archiveWorkspaceRecord: this.dependencies.archiveWorkspaceRecord,
        workspaceRegistry: this.dependencies.workspaceRegistry,
        emitWorkspaceUpdatesForWorkspaceIds: this.dependencies.emitWorkspaceUpdatesForWorkspaceIds,
        markWorkspaceArchiving: this.dependencies.markWorkspaceArchiving,
        clearWorkspaceArchiving: this.dependencies.clearWorkspaceArchiving,
        killTerminalsForWorkspace: this.dependencies.killTerminalsForWorkspace,
        sessionLogger: this.dependencies.logger,
      },
      {
        scope: { kind: "workspace", workspaceId: createdWorktree.workspace.workspaceId },
        requestId: randomUUID(),
      },
    );
    requireArchiveCleanupComplete(archiveResult, "Auto-created worktree archive");

    if (options.agentId) {
      this.dependencies.emitAgentRemove(options.agentId);
    }
  }
}

export function registerAgentAutoArchive(input: {
  agentManager: AgentLifecycleEvents;
  agentId: string;
  archive: () => Promise<unknown>;
  retryBaseMs?: number;
  retryMaxMs?: number;
}): LifecycleRegistration {
  let unsubscribe: (() => void) | null = null;
  let archiveTask: Promise<unknown> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastArchiveFailure: unknown | null = null;
  let consecutiveFailures = 0;
  let canceled = false;
  const retryBaseMs = input.retryBaseMs ?? 1_000;
  const retryMaxMs = input.retryMaxMs ?? 60_000;
  const release = () => {
    if (!unsubscribe) return;
    const subscribed = unsubscribe;
    unsubscribe = null;
    subscribed();
  };
  const scheduleRetry = () => {
    if (canceled || retryTimer) return;
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, consecutiveFailures - 1));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attemptArchive();
    }, delay);
    (retryTimer as unknown as { unref?: () => void }).unref?.();
  };
  const attemptArchive = () => {
    if (canceled || archiveTask) return;
    const task = input.archive();
    archiveTask = task;
    void task.then(
      () => {
        if (archiveTask !== task) return;
        archiveTask = null;
        lastArchiveFailure = null;
        consecutiveFailures = 0;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        release();
        return undefined;
      },
      (error: unknown) => {
        if (archiveTask !== task) return;
        archiveTask = null;
        lastArchiveFailure = error;
        consecutiveFailures += 1;
        scheduleRetry();
        return undefined;
      },
    );
  };
  const registration: LifecycleRegistration = {
    async cancel() {
      canceled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      release();
      const pendingArchive = archiveTask;
      if (pendingArchive) {
        await pendingArchive;
      }
      if (lastArchiveFailure) {
        throw lastArchiveFailure;
      }
    },
  };
  unsubscribe = input.agentManager.subscribe(
    (event) => {
      if (event.type !== "agent_stream") return;
      if (
        event.event.type !== "turn_completed" &&
        event.event.type !== "turn_failed" &&
        event.event.type !== "turn_canceled"
      ) {
        return;
      }
      attemptArchive();
    },
    { agentId: input.agentId, replayState: false },
  );
  return registration;
}

function toAutoArchiveTarget(
  createdWorktree: CreatePaseoWorktreeWorkflowResult | null,
): AutoArchiveTarget {
  return createdWorktree
    ? { kind: "created-worktree", result: createdWorktree }
    : { kind: "agent-only" };
}
