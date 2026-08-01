import { randomUUID } from "node:crypto";
import type pino from "pino";

import type { ForgeService } from "../../services/forge-service.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import { isPaseoOwnedWorktreeCwd } from "../../utils/worktree.js";
import {
  archiveByScope,
  requireArchiveCleanupComplete,
  type ActiveWorkspaceRef,
  WorkspaceCleanupPendingError,
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
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list" | "update" | "subscribeToMutations">;
  emit: (message: SessionOutboundMessage) => void;
  emitAgentRemove: (agentId: string) => void;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  killTerminalsForWorkspace: (workspaceId: string) => Promise<void>;
  logger: pino.Logger;
}

export interface LifecycleRegistration {
  readonly settled: Promise<"completed" | "cancelled">;
  cancel(): Promise<void>;
}

interface AgentLifecycleEvents {
  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void;
}

const inactiveRegistration: LifecycleRegistration = {
  settled: Promise.resolve("cancelled"),
  cancel: async () => undefined,
};

export interface LifecycleDispatchShutdownResult {
  completed: boolean;
  pendingAgentIds: string[];
}

type AutoArchiveTarget =
  | { kind: "agent-only" }
  | { kind: "created-worktree"; result: CreatePaseoWorktreeWorkflowResult };

export class CreateAgentLifecycleDispatch {
  private readonly autoArchiveTasks = new Map<string, Promise<void>>();
  private readonly autoArchiveRegistrations = new Map<string, LifecycleRegistration>();
  private shuttingDown = false;

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
    if (this.shuttingDown) return inactiveRegistration;
    const existing = this.autoArchiveRegistrations.get(agentId);
    if (existing) return existing;

    const subscribeToMutations = this.dependencies.workspaceRegistry.subscribeToMutations?.bind(
      this.dependencies.workspaceRegistry,
    );
    const registration = registerAgentAutoArchive({
      agentManager: this.dependencies.agentManager,
      agentId,
      archive: () => this.autoArchiveAgentOnce(agentId, target),
      shouldRetry: (error) => !(error instanceof WorkspaceCleanupPendingError),
      subscribeToRearm: subscribeToMutations
        ? (rearm) => subscribeToMutations(() => rearm())
        : undefined,
    });
    this.autoArchiveRegistrations.set(agentId, registration);
    void registration.settled.then(() => {
      if (this.autoArchiveRegistrations.get(agentId) === registration) {
        this.autoArchiveRegistrations.delete(agentId);
      }
      return undefined;
    });
    return registration;
  }

  async shutdown(options?: { timeoutMs?: number }): Promise<LifecycleDispatchShutdownResult> {
    this.shuttingDown = true;
    const registrations = Array.from(this.autoArchiveRegistrations.entries());
    const cancellation = Promise.allSettled(
      registrations.map(([, registration]) => registration.cancel()),
    ).then(async () => {
      await Promise.allSettled(Array.from(this.autoArchiveTasks.values()));
      return undefined;
    });
    try {
      await withTimeout(
        cancellation,
        options?.timeoutMs ?? 10_000,
        "Timed out shutting down create-agent lifecycle registrations",
      );
    } catch (error) {
      this.dependencies.logger.error(
        { err: error, agentIds: registrations.map(([registeredAgentId]) => registeredAgentId) },
        "Create-agent lifecycle shutdown remains incomplete",
      );
    }
    const pendingAgentIds = Array.from(
      new Set([...this.autoArchiveRegistrations.keys(), ...this.autoArchiveTasks.keys()]),
    );
    return { completed: pendingAgentIds.length === 0, pendingAgentIds };
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
  shouldRetry?: (error: unknown) => boolean;
  subscribeToRearm?: (rearm: () => void) => () => void;
}): LifecycleRegistration {
  let unsubscribe: (() => void) | null = null;
  let unsubscribeRearm: (() => void) | null = null;
  let archiveTask: Promise<unknown> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastArchiveFailure: unknown | null = null;
  let consecutiveFailures = 0;
  let mutationVersion = 0;
  let awaitingRearm = false;
  let terminalObserved = false;
  let canceled = false;
  let settleRegistration!: (result: "completed" | "cancelled") => void;
  let registrationSettled = false;
  const settled = new Promise<"completed" | "cancelled">((resolve) => {
    settleRegistration = resolve;
  });
  const retryBaseMs = input.retryBaseMs ?? 1_000;
  const retryMaxMs = input.retryMaxMs ?? 60_000;
  const settle = (result: "completed" | "cancelled") => {
    if (registrationSettled) return;
    registrationSettled = true;
    settleRegistration(result);
  };
  const release = () => {
    const subscribedToAgent = unsubscribe;
    unsubscribe = null;
    subscribedToAgent?.();
    const subscribedToRearm = unsubscribeRearm;
    unsubscribeRearm = null;
    subscribedToRearm?.();
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
  if (input.subscribeToRearm) {
    unsubscribeRearm = input.subscribeToRearm(() => {
      mutationVersion += 1;
      if (!canceled && terminalObserved && awaitingRearm && !archiveTask) {
        awaitingRearm = false;
        consecutiveFailures = 0;
        attemptArchive();
      }
    });
  }
  function attemptArchive(): void {
    if (canceled || archiveTask) return;
    const attemptMutationVersion = mutationVersion;
    const task = Promise.resolve().then(input.archive);
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
        settle("completed");
        return undefined;
      },
      (error: unknown) => {
        if (archiveTask !== task) return;
        archiveTask = null;
        lastArchiveFailure = error;
        consecutiveFailures += 1;
        const retryAllowed = input.shouldRetry?.(error) ?? true;
        if (!retryAllowed) {
          awaitingRearm = true;
          if (!canceled && terminalObserved && mutationVersion !== attemptMutationVersion) {
            awaitingRearm = false;
            consecutiveFailures = 0;
            attemptArchive();
          }
        } else {
          scheduleRetry();
        }
        return undefined;
      },
    );
  }
  const registration: LifecycleRegistration = {
    settled,
    async cancel() {
      canceled = true;
      awaitingRearm = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      release();
      try {
        const pendingArchive = archiveTask;
        if (pendingArchive) {
          await pendingArchive;
        }
        if (lastArchiveFailure) {
          throw lastArchiveFailure;
        }
      } finally {
        settle("cancelled");
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
      terminalObserved = true;
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
