import type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  CreateAgentWorktreeTarget,
} from "@getpaseo/protocol/messages";

import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { LifecycleRegistration } from "../agent/create-agent-lifecycle-dispatch.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { buildStoredAgentPayload } from "../agent/agent-projections.js";
import { serializeAgentSnapshot, serializeAgentStreamEvent } from "../messages.js";
import { daemonExecutionKey, type DaemonAgentOwner } from "../agent/agent-owner.js";

export interface HubExecutionAgentCreateInput {
  executionId: string;
  provider: string;
  cwd: string;
  workspaceId?: string;
  prompt: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  env?: Record<string, string>;
  worktree?: CreateAgentWorktreeTarget;
  autoArchive?: boolean;
}

export interface OwnedAgentSnapshot {
  executionId: string;
  agent: AgentSnapshotPayload;
}

export type OwnedAgentEvent =
  | { type: "update"; executionId: string; agent: AgentSnapshotPayload }
  | {
      type: "stream";
      executionId: string;
      agentId: string;
      event: AgentStreamEventPayload;
    };

interface DaemonExecutionsOptions {
  daemonId: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  registerAutoArchive?: (input: {
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }) => LifecycleRegistration;
  cleanupFailedCreate?: (input: {
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
    createdAgentId: string | null;
  }) => Promise<void>;
}

export interface HubExecutionAgents {
  create(input: HubExecutionAgentCreateInput): Promise<OwnedAgentSnapshot>;
  subscribe(listener: (event: OwnedAgentEvent) => void): () => void;
  invalidateAuthority(): Promise<void>;
}

export class DaemonExecutions implements HubExecutionAgents {
  private readonly daemonId: string;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgentCommand: BoundCreateAgentCommand;
  private readonly pendingCreates = new Map<string, Promise<OwnedAgentSnapshot>>();
  private authorityGeneration = 0;
  private authorityActive = true;
  private readonly registerAutoArchive: (input: {
    agentId: string;
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  }) => LifecycleRegistration;
  private readonly cleanupFailedCreate: NonNullable<DaemonExecutionsOptions["cleanupFailedCreate"]>;

  constructor(options: DaemonExecutionsOptions) {
    this.daemonId = options.daemonId;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgentCommand = options.createAgent;
    this.registerAutoArchive =
      options.registerAutoArchive ?? (() => ({ cancel: async () => undefined }));
    this.cleanupFailedCreate = options.cleanupFailedCreate ?? (async () => undefined);
  }

  create(input: HubExecutionAgentCreateInput): Promise<OwnedAgentSnapshot> {
    if (!this.authorityActive) {
      return Promise.reject(new Error("Hub relationship authority is no longer active"));
    }
    const owner = this.owner(input.executionId);
    const key = daemonExecutionKey(owner);
    const pending = this.pendingCreates.get(key);
    if (pending) {
      return pending;
    }

    const authorityGeneration = this.authorityGeneration;
    const create = this.createOrResolve(owner, input, authorityGeneration).finally(() => {
      if (this.pendingCreates.get(key) === create) {
        this.pendingCreates.delete(key);
      }
    });
    this.pendingCreates.set(key, create);
    return create;
  }

  async invalidateAuthority(): Promise<void> {
    this.authorityActive = false;
    this.authorityGeneration++;
    await Promise.allSettled(this.pendingCreates.values());
  }

  subscribe(listener: (event: OwnedAgentEvent) => void): () => void {
    return this.agentManager.subscribe(
      (event) => {
        const owned = this.projectEvent(event);
        if (owned) {
          listener(owned);
        }
      },
      { replayState: true },
    );
  }

  private async createOrResolve(
    owner: DaemonAgentOwner,
    input: HubExecutionAgentCreateInput,
    authorityGeneration: number,
  ): Promise<OwnedAgentSnapshot> {
    const existing = await this.agentStorage.findByDaemonExecution(owner);
    if (existing) {
      this.requireAuthority(authorityGeneration);
      return this.resolveRecord(existing);
    }
    this.requireAuthority(authorityGeneration);

    let createdWorktree: CreatePaseoWorktreeWorkflowResult | null = null;
    let createdAgentId: string | null = null;
    let autoArchiveRegistration: LifecycleRegistration = { cancel: async () => undefined };
    let result: Awaited<ReturnType<BoundCreateAgentCommand>>;
    try {
      result = await this.createAgentCommand({
        kind: "mcp",
        provider: input.model ? `${input.provider}/${input.model}` : input.provider,
        title: input.prompt,
        initialPrompt: input.prompt,
        promptFailure: "throw",
        cwd: input.cwd,
        workspaceId: input.workspaceId,
        mode: input.modeId,
        thinking: input.thinkingOptionId,
        features: input.featureValues,
        env: input.env,
        worktree: toCreateAgentWorktree(input.worktree),
        background: true,
        notifyOnFinish: false,
        owner,
        onWorktreeCreated: (worktree) => {
          createdWorktree = worktree;
        },
        onCreated: (created) => {
          createdAgentId = created.agentId;
          if (input.autoArchive === true) {
            autoArchiveRegistration = this.registerAutoArchive({
              ...created,
              createdWorktree: ownedCreatedWorktree(created.createdWorktree),
            });
          }
        },
      });
      this.requireAuthority(authorityGeneration);
    } catch (error) {
      try {
        await autoArchiveRegistration.cancel();
        if (createdAgentId && this.agentManager.getAgent(createdAgentId)) {
          try {
            await this.agentManager.closeAgent(createdAgentId);
          } finally {
            await this.agentManager.deleteAgentState(createdAgentId);
          }
        }
      } finally {
        try {
          await this.cleanupFailedCreate({
            createdWorktree: ownedCreatedWorktree(createdWorktree),
            createdAgentId: null,
          });
        } finally {
          if (createdAgentId) {
            await this.agentStorage.remove(createdAgentId);
          }
        }
      }
      throw error;
    }

    return {
      executionId: owner.executionId,
      agent: serializeAgentSnapshot(result.liveSnapshot),
    };
  }

  private resolveRecord(record: StoredAgentRecord): OwnedAgentSnapshot {
    return this.projectRecord(record);
  }

  private requireAuthority(authorityGeneration: number): void {
    if (!this.authorityActive || authorityGeneration !== this.authorityGeneration) {
      throw new Error("Hub relationship authority ended during agent creation");
    }
  }

  private projectRecord(record: StoredAgentRecord): OwnedAgentSnapshot {
    const owner = this.requireOwner(record);
    const live = this.agentManager.getAgent(record.id);
    return {
      executionId: owner.executionId,
      agent: live
        ? serializeAgentSnapshot(live)
        : {
            ...buildStoredAgentPayload(record, this.agentManager.getRegisteredProviderIds()),
            status: "closed",
          },
    };
  }

  private projectEvent(event: AgentManagerEvent): OwnedAgentEvent | null {
    if (event.type === "agent_state") {
      return this.projectAgentState(event.agent);
    }
    if (event.type !== "agent_stream") {
      return null;
    }
    const agent = this.agentManager.getAgent(event.agentId);
    if (!this.isOwned(agent)) {
      return null;
    }
    const serialized = serializeAgentStreamEvent(event.event);
    if (!serialized) {
      return null;
    }
    return {
      type: "stream",
      executionId: agent.owner.executionId,
      agentId: agent.id,
      event: serialized,
    };
  }

  private projectAgentState(agent: ManagedAgent): OwnedAgentEvent | null {
    if (!this.isOwned(agent)) {
      return null;
    }
    return {
      type: "update",
      executionId: agent.owner.executionId,
      agent: serializeAgentSnapshot(agent),
    };
  }

  private isOwned(agent: ManagedAgent | null): agent is ManagedAgent & { owner: DaemonAgentOwner } {
    return agent?.owner?.kind === "daemon" && agent.owner.daemonId === this.daemonId;
  }

  private owner(executionId: string): DaemonAgentOwner {
    return { kind: "daemon", daemonId: this.daemonId, executionId };
  }

  private requireOwner(record: StoredAgentRecord): DaemonAgentOwner {
    const owner = record.owner;
    if (owner?.kind !== "daemon" || owner.daemonId !== this.daemonId) {
      throw new Error(`Agent ${record.id} is not owned by daemon ${this.daemonId}`);
    }
    return owner;
  }
}

function ownedCreatedWorktree(
  worktree: CreatePaseoWorktreeWorkflowResult | null,
): CreatePaseoWorktreeWorkflowResult | null {
  return worktree?.created === true ? worktree : null;
}

function toCreateAgentWorktree(target: CreateAgentWorktreeTarget | undefined) {
  if (!target) return undefined;
  if (target.mode === "branch-off") {
    return {
      worktreeName: target.newBranch,
      baseBranch: target.base,
      action: "branch-off" as const,
    };
  }
  if (target.mode === "checkout-branch") {
    return { refName: target.branch, action: "checkout" as const };
  }
  return { githubPrNumber: target.prNumber, action: "checkout" as const };
}
