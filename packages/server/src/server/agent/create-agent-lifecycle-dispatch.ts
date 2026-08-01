import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type pino from "pino";

import type { ForgeService } from "../../services/forge-service.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import { isPaseoOwnedWorktreeCwd } from "../../utils/worktree.js";
import {
  readPaseoWorktreeMetadata,
  writePaseoWorktreeMetadata,
} from "../../utils/worktree-metadata.js";
import {
  archiveByScope,
  requireArchiveCleanupComplete,
  type ActiveWorkspaceRef,
  WorkspaceCleanupPendingError,
} from "../workspace-archive-service.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { SessionOutboundMessage } from "../messages.js";
import type { AgentManager, AgentSubscriber, SubscribeOptions } from "./agent-manager.js";
import type { AgentStorage, AutoArchiveObligation } from "./agent-storage.js";

interface CreateAgentLifecycleDispatchDependencies {
  paseoHome: string;
  worktreesRoot?: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  github: ForgeService;
  workspaceGitService: WorkspaceGitService;
  archiveAgentForClose: (agentId: string) => Promise<unknown>;
  archiveWorkspaceForClose: (workspaceId: string, signal?: AbortSignal) => Promise<unknown>;
  drainWorkspaceLifecycleOperations: () => Promise<void>;
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
  readonly settled: Promise<"completed" | "cancelled" | "unresolved">;
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

export class CreateAgentLifecycleDispatch {
  private readonly autoArchiveTasks = new Map<string, Promise<void>>();
  private readonly autoArchiveRegistrations = new Map<string, LifecycleRegistration>();
  private readonly failedCreateCleanupTasks = new Map<string, Promise<void>>();
  private readonly shutdownController = new AbortController();
  private shuttingDown = false;

  constructor(private readonly dependencies: CreateAgentLifecycleDispatchDependencies) {}

  registerAutoArchiveIfRequested(input: {
    autoArchive: boolean | undefined;
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }): LifecycleRegistration {
    if (input.autoArchive !== true) {
      return inactiveRegistration;
    }

    return this.registerAutoArchive({
      agentId: input.agentId,
      obligation: {
        phase: "armed",
        target: input.createdWorktree
          ? { kind: "workspace", workspaceId: input.createdWorktree.workspace.workspaceId }
          : { kind: "agent" },
      },
    });
  }

  registerAutoArchive(input: {
    agentId: string;
    obligation: AutoArchiveObligation;
  }): LifecycleRegistration {
    if (input.obligation.phase === "pending") {
      void this.autoArchiveAgentOnce(input.agentId, input.obligation.target).catch(() => undefined);
      return inactiveRegistration;
    }
    return this.registerAutoArchiveOnTerminalState(input.agentId, input.obligation.target);
  }

  async recoverPersistedAutoArchives(): Promise<void> {
    const records = await this.dependencies.agentStorage.list();
    for (const record of records) {
      if (!record.autoArchiveObligation) continue;
      void this.autoArchiveAgentOnce(record.id, record.autoArchiveObligation.target).catch(
        () => undefined,
      );
    }
  }

  async recoverPendingAgentCreations(): Promise<void> {
    const records = await this.dependencies.agentStorage.listPendingAgentCreations();
    for (const record of records) {
      await this.recoverPendingAgentCreation(record.agentId);
    }
  }

  async recoverPendingAgentCreation(agentId: string): Promise<void> {
    const pending = (await this.dependencies.agentStorage.listPendingAgentCreations()).find(
      (record) => record.agentId === agentId,
    );
    if (!pending) return;

    if (
      (await this.dependencies.agentStorage.get(agentId)) ||
      pending.cleanupTarget.kind === "agent"
    ) {
      await this.dependencies.agentStorage.removePendingAgentCreation(agentId);
      return;
    }

    const targetPath = resolvePath(pending.cleanupTarget.targetPath);
    try {
      if (!existsSync(targetPath)) {
        const ownsActiveWorkspace = (await this.dependencies.workspaceRegistry.list()).some(
          (workspace) =>
            !workspace.archivedAt &&
            resolvePath(workspace.worktreeRoot ?? workspace.cwd) === targetPath,
        );
        if (!ownsActiveWorkspace) {
          await this.dependencies.agentStorage.removePendingAgentCreation(agentId);
          return;
        }
      }

      if (existsSync(targetPath)) {
        const targetStat = statSync(targetPath, { bigint: true });
        const currentDirectoryIdentity = {
          device: targetStat.dev.toString(),
          inode: targetStat.ino.toString(),
        };
        if (
          currentDirectoryIdentity.device !== pending.cleanupTarget.directoryIdentity.device ||
          currentDirectoryIdentity.inode !== pending.cleanupTarget.directoryIdentity.inode
        ) {
          this.dependencies.logger.warn(
            { agentId, worktreePath: targetPath },
            "Pending agent creation no longer owns its worktree path",
          );
          await this.dependencies.agentStorage.removePendingAgentCreation(agentId);
          return;
        }

        const gitPath = resolvePath(targetPath, ".git");
        if (!existsSync(gitPath)) {
          await rm(targetPath, { recursive: true, force: true });
          await this.dependencies.agentStorage.removePendingAgentCreation(agentId);
          return;
        }
        const metadata = readPaseoWorktreeMetadata(targetPath);
        if (
          metadata?.incarnationId &&
          metadata.incarnationId !== pending.cleanupTarget.worktreeIncarnationId
        ) {
          this.dependencies.logger.warn(
            { agentId, worktreePath: targetPath },
            "Pending agent creation found a replacement worktree incarnation",
          );
          await this.dependencies.agentStorage.removePendingAgentCreation(agentId);
          return;
        }
        if (!metadata?.incarnationId) {
          writePaseoWorktreeMetadata(targetPath, {
            baseRefName: metadata?.baseRefName ?? pending.cleanupTarget.metadataBaseRefName,
            incarnationId: pending.cleanupTarget.worktreeIncarnationId,
            ...(metadata?.changeRequestLookupTarget
              ? { changeRequestLookupTarget: metadata.changeRequestLookupTarget }
              : {}),
          });
        }
      }

      await this.archiveWorktreePath(targetPath);
      await this.dependencies.agentStorage.removePendingAgentCreation(agentId);
    } catch (error) {
      this.dependencies.logger.warn(
        { err: error, agentId, worktreePath: targetPath },
        "Failed to recover pending agent creation",
      );
    }
  }

  async cleanupCreatedWorktreeAfterFailedAgentCreate(input: {
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
    createdAgentId: string | null;
  }): Promise<void> {
    const { createdWorktree, createdAgentId } = input;
    if (!createdWorktree?.created || createdAgentId) {
      return;
    }

    const worktreePath = createdWorktree.worktree.worktreePath;
    const existingTask = this.failedCreateCleanupTasks.get(worktreePath);
    if (existingTask) return existingTask;

    const cleanupTask = this.archiveAutoCreatedWorktree({
      agentId: null,
      createdWorktree,
    }).catch((archiveError) => {
      this.dependencies.logger.warn(
        { err: archiveError, worktreePath },
        "Failed to clean up worktree after create_agent_request failed",
      );
    });
    this.failedCreateCleanupTasks.set(worktreePath, cleanupTask);
    try {
      await cleanupTask;
    } finally {
      if (this.failedCreateCleanupTasks.get(worktreePath) === cleanupTask) {
        this.failedCreateCleanupTasks.delete(worktreePath);
      }
    }
  }

  private registerAutoArchiveOnTerminalState(
    agentId: string,
    target: AutoArchiveObligation["target"],
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
        ? (rearm) => subscribeToMutations((mutation) => rearm(mutation.workspaceId))
        : undefined,
      rearmKeysForError: (error) =>
        error instanceof WorkspaceCleanupPendingError ? error.workspaceIds : [],
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
    this.shutdownController.abort();
    const registrations = Array.from(this.autoArchiveRegistrations.entries());
    const cancellation = Promise.allSettled(
      registrations.map(([, registration]) => registration.cancel()),
    ).then(async (results) => {
      await Promise.allSettled(Array.from(this.autoArchiveTasks.values()));
      await this.dependencies.drainWorkspaceLifecycleOperations();
      await Promise.allSettled(Array.from(this.failedCreateCleanupTasks.values()));
      await this.dependencies.drainWorkspaceLifecycleOperations();
      return results;
    });
    let cancellationResults: PromiseSettledResult<void>[] | null = null;
    try {
      cancellationResults = await withTimeout(
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
    const unresolvedAgentIds = cancellationResults
      ? registrations.flatMap(([agentId], index) =>
          cancellationResults[index]?.status === "rejected" ? [agentId] : [],
        )
      : registrations.map(([agentId]) => agentId);
    const pendingAgentIds = Array.from(
      new Set([
        ...unresolvedAgentIds,
        ...this.autoArchiveRegistrations.keys(),
        ...this.autoArchiveTasks.keys(),
      ]),
    );
    return {
      completed:
        cancellationResults !== null &&
        pendingAgentIds.length === 0 &&
        this.failedCreateCleanupTasks.size === 0,
      pendingAgentIds,
    };
  }

  private async autoArchiveAgentOnce(
    agentId: string,
    target: AutoArchiveObligation["target"],
  ): Promise<void> {
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

  private async runAutoArchiveAgent(
    agentId: string,
    target: AutoArchiveObligation["target"],
  ): Promise<void> {
    await this.dependencies.agentStorage.update(agentId, (record) => ({
      ...record,
      autoArchiveObligation: { phase: "pending", target },
    }));
    if (target.kind === "workspace") {
      await this.dependencies.archiveWorkspaceForClose(
        target.workspaceId,
        this.shutdownController.signal,
      );
      const workspace = await this.dependencies.workspaceRegistry.get(target.workspaceId);
      if (!workspace?.archivedAt || workspace.cleanupPending) {
        throw new WorkspaceCleanupPendingError("Workspace auto-archive verification", [
          target.workspaceId,
        ]);
      }
    } else {
      await this.dependencies.archiveAgentForClose(agentId);
    }
    await this.dependencies.agentStorage.update(agentId, (record) => {
      return { ...record, autoArchiveObligation: undefined };
    });
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

    await this.archiveWorktreePath(worktreePath, createdWorktree.workspace.workspaceId);

    if (options.agentId) {
      this.dependencies.emitAgentRemove(options.agentId);
    }
  }

  private async archiveWorktreePath(worktreePath: string, workspaceId?: string): Promise<void> {
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
        scope: workspaceId
          ? { kind: "workspace", workspaceId }
          : { kind: "worktree", targetPath: worktreePath },
        requestId: randomUUID(),
      },
    );
    requireArchiveCleanupComplete(archiveResult, "Auto-created worktree archive");
  }
}

export function registerAgentAutoArchive(input: {
  agentManager: AgentLifecycleEvents;
  agentId: string;
  archive: () => Promise<unknown>;
  retryBaseMs?: number;
  retryMaxMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  subscribeToRearm?: (rearm: (key: string) => void) => () => void;
  rearmKeysForError?: (error: unknown) => readonly string[];
}): LifecycleRegistration {
  let unsubscribe: (() => void) | null = null;
  let unsubscribeRearm: (() => void) | null = null;
  let archiveTask: Promise<unknown> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastArchiveFailure: unknown | null = null;
  let consecutiveFailures = 0;
  let mutationVersion = 0;
  const mutationVersionByKey = new Map<string, number>();
  let awaitingRearm = false;
  let terminalObserved = false;
  let canceled = false;
  let settleRegistration!: (result: "completed" | "cancelled" | "unresolved") => void;
  let registrationSettled = false;
  const settled = new Promise<"completed" | "cancelled" | "unresolved">((resolve) => {
    settleRegistration = resolve;
  });
  const retryBaseMs = input.retryBaseMs ?? 1_000;
  const retryMaxMs = input.retryMaxMs ?? 60_000;
  const settle = (result: "completed" | "cancelled" | "unresolved") => {
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
    unsubscribeRearm = input.subscribeToRearm((key) => {
      mutationVersion += 1;
      mutationVersionByKey.set(key, mutationVersion);
      const rearmKeys = lastArchiveFailure
        ? (input.rearmKeysForError?.(lastArchiveFailure) ?? null)
        : null;
      if (
        !canceled &&
        terminalObserved &&
        awaitingRearm &&
        !archiveTask &&
        (rearmKeys === null || rearmKeys.includes(key))
      ) {
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
          const rearmKeys = input.rearmKeysForError?.(error) ?? null;
          const relevantMutationObserved = rearmKeys
            ? rearmKeys.some((key) => (mutationVersionByKey.get(key) ?? 0) > attemptMutationVersion)
            : mutationVersion !== attemptMutationVersion;
          if (!canceled && terminalObserved && relevantMutationObserved) {
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
          await pendingArchive.catch(() => undefined);
        }
        if (lastArchiveFailure) {
          throw lastArchiveFailure;
        }
        settle("cancelled");
      } catch (error) {
        settle("unresolved");
        throw error;
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
