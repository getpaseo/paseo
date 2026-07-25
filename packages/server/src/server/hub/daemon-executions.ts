import type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  CreateAgentWorktreeTarget,
  HubExecutionControlAction,
} from "@getpaseo/protocol/messages";

import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import type { ActiveWorkspaceRef } from "../workspace-archive-service.js";
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
}

export interface HubExecutionControlInput {
  requestId: string;
  executionId: string;
  action: HubExecutionControlAction;
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
  interruptAgent: (agentId: string) => Promise<unknown>;
  archiveAgent: (agentId: string) => Promise<unknown>;
  listActiveWorkspaces: () => Promise<ActiveWorkspaceRef[]>;
  archiveWorkspace: (workspaceId: string, requestId: string) => Promise<unknown>;
  cleanupFailedCreate?: (input: {
    createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
    createdAgentId: string | null;
  }) => Promise<void>;
}

export interface HubExecutionAgents {
  create(input: HubExecutionAgentCreateInput): Promise<OwnedAgentSnapshot>;
  control(input: HubExecutionControlInput): Promise<void>;
  subscribe(listener: (event: OwnedAgentEvent) => void): () => void;
  invalidateAuthority(): Promise<void>;
}

export class DaemonExecutions implements HubExecutionAgents {
  private readonly daemonId: string;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgentCommand: BoundCreateAgentCommand;
  private readonly pendingCreates = new Map<string, Promise<OwnedAgentSnapshot>>();
  private readonly pendingControlActions = new Map<string, Promise<void>>();
  private readonly controlTails = new Map<string, Promise<void>>();
  private authorityGeneration = 0;
  private authorityActive = true;
  private readonly cleanupFailedCreate: NonNullable<DaemonExecutionsOptions["cleanupFailedCreate"]>;

  constructor(private readonly options: DaemonExecutionsOptions) {
    this.daemonId = options.daemonId;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgentCommand = options.createAgent;
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

  control(input: HubExecutionControlInput): Promise<void> {
    if (!this.authorityActive) {
      return Promise.reject(new Error("Hub relationship authority is no longer active"));
    }
    const owner = this.owner(input.executionId);
    const executionKey = daemonExecutionKey(owner);
    const actionKey = `${executionKey}\0${input.action}`;
    const pending = this.pendingControlActions.get(actionKey);
    if (pending) return pending;

    const previous =
      this.controlTails.get(executionKey) ??
      this.pendingCreates.get(executionKey)?.then(() => undefined) ??
      Promise.resolve();
    const authorityGeneration = this.authorityGeneration;
    const control = previous
      .catch(() => undefined)
      .then(() => this.controlOwnedExecution(owner, input, authorityGeneration));
    this.pendingControlActions.set(actionKey, control);
    this.controlTails.set(executionKey, control);
    const release = () => {
      if (this.pendingControlActions.get(actionKey) === control) {
        this.pendingControlActions.delete(actionKey);
      }
      if (this.controlTails.get(executionKey) === control) {
        this.controlTails.delete(executionKey);
      }
    };
    void control.then(release, release);
    return control;
  }

  async invalidateAuthority(): Promise<void> {
    this.authorityActive = false;
    this.authorityGeneration++;
    await Promise.allSettled([
      ...this.pendingCreates.values(),
      ...this.pendingControlActions.values(),
    ]);
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
          if (worktree.created) {
            owner.createdWorkspaceId = worktree.workspace.workspaceId;
          }
        },
        onCreated: (created) => {
          createdAgentId = created.agentId;
        },
      });
      this.requireAuthority(authorityGeneration);
    } catch (error) {
      try {
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

  private async controlOwnedExecution(
    owner: DaemonAgentOwner,
    input: HubExecutionControlInput,
    authorityGeneration: number,
  ): Promise<void> {
    this.requireAuthority(authorityGeneration, "execution control");
    const record = await this.agentStorage.findByDaemonExecution(owner);
    this.requireAuthority(authorityGeneration, "execution control");
    if (!record) {
      return;
    }
    const storedOwner = this.requireOwner(record);

    if (input.action === "interrupt") {
      if (!record.archivedAt && this.agentManager.getAgent(record.id)) {
        await this.options.interruptAgent(record.id);
      }
      return;
    }

    const workspace = storedOwner.createdWorkspaceId
      ? (await this.options.listActiveWorkspaces()).find(
          (candidate) => candidate.workspaceId === storedOwner.createdWorkspaceId,
        )
      : undefined;

    if (!record.archivedAt) {
      this.requireAuthority(authorityGeneration, "execution control");
      await this.options.archiveAgent(record.id);
    }
    if (workspace?.isPaseoOwnedWorktree) {
      this.requireAuthority(authorityGeneration, "execution control");
      await this.options.archiveWorkspace(workspace.workspaceId, input.requestId);
    }
  }

  private resolveRecord(record: StoredAgentRecord): OwnedAgentSnapshot {
    return this.projectRecord(record);
  }

  private requireAuthority(authorityGeneration: number, operation = "agent creation"): void {
    if (!this.authorityActive || authorityGeneration !== this.authorityGeneration) {
      throw new Error(`Hub relationship authority ended during ${operation}`);
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
