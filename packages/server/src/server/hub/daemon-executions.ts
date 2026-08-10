import { createHash } from "node:crypto";
import type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  CreateAgentWorktreeTarget,
  HubExecutionControlAction,
} from "@getpaseo/protocol/messages";
import type { ProviderOptions, ToolPolicy } from "@getpaseo/protocol/agent-types";

import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { McpServerConfig } from "../agent/agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { buildStoredAgentPayload } from "../agent/agent-projections.js";
import { serializeAgentSnapshot, serializeAgentStreamEvent } from "../messages.js";
import { daemonExecutionKey, type DaemonAgentOwner } from "../agent/agent-owner.js";

export interface HubExecutionAgentCreateInput {
  executionId: string;
  provider: string;
  cwd: string;
  prompt: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  providerOptions?: ProviderOptions;
  toolPolicy?: ToolPolicy;
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerConfig>;
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
  providerOptionsApplied: boolean;
  toolPolicyApplied: boolean;
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
  private readonly pendingCreates = new Map<
    string,
    { fingerprint: string; promise: Promise<OwnedAgentSnapshot> }
  >();
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
    const fingerprint = fingerprintHubExecutionCreate(input);
    const owner = this.owner(input.executionId, fingerprint);
    const key = daemonExecutionKey(owner);
    const pending = this.pendingCreates.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        return Promise.reject(createInputMismatchError(input.executionId));
      }
      return pending.promise;
    }

    const authorityGeneration = this.authorityGeneration;
    const create = this.createOrResolve(owner, input, authorityGeneration).finally(() => {
      if (this.pendingCreates.get(key)?.promise === create) {
        this.pendingCreates.delete(key);
      }
    });
    this.pendingCreates.set(key, { fingerprint, promise: create });
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
      this.pendingCreates.get(executionKey)?.promise.then(() => undefined) ??
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
      ...[...this.pendingCreates.values()].map((pending) => pending.promise),
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
      requireExecutionWorkspaceId(existing);
      this.requireMatchingCreate(existing, input, owner.createFingerprint);
      this.requireAuthority(authorityGeneration);
      return this.resolveRecord(existing, input);
    }
    this.requireAuthority(authorityGeneration);
    requireHubMcpNamespace(input.mcpServers);
    requireToolPolicyServers(input.toolPolicy, input.mcpServers);

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
        mode: input.modeId,
        thinking: input.thinkingOptionId,
        features: input.featureValues,
        env: input.env,
        ...(input.mcpServers || input.providerOptions || input.toolPolicy
          ? {
              config: {
                ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
                ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
                ...(input.toolPolicy ? { toolPolicy: input.toolPolicy } : {}),
              },
            }
          : {}),
        worktree: toCreateAgentWorktree(input.worktree),
        background: true,
        notifyOnFinish: false,
        owner,
        onWorktreeCreated: (worktree) => {
          createdWorktree = worktree;
        },
        onCreated: (created) => {
          createdAgentId = created.agentId;
        },
      });
      this.requireAuthority(authorityGeneration);
      requireExecutionWorkspaceId(result.liveSnapshot);
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
      providerOptionsApplied: input.providerOptions !== undefined,
      toolPolicyApplied: input.toolPolicy !== undefined,
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
    this.requireOwner(record);

    if (input.action === "interrupt") {
      if (!record.archivedAt && this.agentManager.getAgent(record.id)) {
        await this.options.interruptAgent(record.id);
      }
      return;
    }

    const workspaceId = requireExecutionWorkspaceId(record);
    this.requireAuthority(authorityGeneration, "execution control");
    await this.options.archiveWorkspace(workspaceId, input.requestId);
  }

  private resolveRecord(
    record: StoredAgentRecord,
    input: HubExecutionAgentCreateInput,
  ): OwnedAgentSnapshot {
    requireExecutionWorkspaceId(record);
    return this.projectRecord(record, input);
  }

  private requireAuthority(authorityGeneration: number, operation = "agent creation"): void {
    if (!this.authorityActive || authorityGeneration !== this.authorityGeneration) {
      throw new Error(`Hub relationship authority ended during ${operation}`);
    }
  }

  private projectRecord(
    record: StoredAgentRecord,
    input: HubExecutionAgentCreateInput,
  ): OwnedAgentSnapshot {
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
      providerOptionsApplied: input.providerOptions !== undefined,
      toolPolicyApplied: input.toolPolicy !== undefined,
    };
  }

  private requireMatchingCreate(
    record: StoredAgentRecord,
    input: HubExecutionAgentCreateInput,
    requestedFingerprint: string | undefined,
  ): void {
    const owner = this.requireOwner(record);
    if (owner.createFingerprint === undefined) {
      if (
        input.providerOptions !== undefined ||
        input.toolPolicy !== undefined ||
        input.mcpServers
      ) {
        throw createInputMismatchError(input.executionId);
      }
      return;
    }
    if (owner.createFingerprint !== requestedFingerprint) {
      throw createInputMismatchError(input.executionId);
    }
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

  private owner(executionId: string, createFingerprint?: string): DaemonAgentOwner {
    return { kind: "daemon", daemonId: this.daemonId, executionId, createFingerprint };
  }

  private requireOwner(record: StoredAgentRecord): DaemonAgentOwner {
    const owner = record.owner;
    if (owner?.kind !== "daemon" || owner.daemonId !== this.daemonId) {
      throw new Error(`Agent ${record.id} is not owned by daemon ${this.daemonId}`);
    }
    return owner;
  }
}

function fingerprintHubExecutionCreate(input: HubExecutionAgentCreateInput): string {
  return createHash("sha256")
    .update(JSON.stringify(sortJsonValue(input)))
    .digest("hex");
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function createInputMismatchError(executionId: string): Error {
  return new Error(`Hub execution ${executionId} is already bound to a different create request`);
}

function requireHubMcpNamespace(mcpServers: Record<string, McpServerConfig> | undefined): void {
  if (mcpServers && Object.hasOwn(mcpServers, "paseo")) {
    throw new Error('Hub execution MCP server name "paseo" is reserved by the daemon');
  }
}

function requireToolPolicyServers(
  toolPolicy: ToolPolicy | undefined,
  mcpServers: Record<string, McpServerConfig> | undefined,
): void {
  if (!toolPolicy) return;
  const serverNames = new Set(Object.keys(mcpServers ?? {}));
  for (const grant of toolPolicy.preapproved) {
    if (!serverNames.has(grant.server)) {
      throw new Error(
        `Hub tool preapproval '${grant.server}.${grant.tool}' requires MCP server '${grant.server}' in the same create request`,
      );
    }
  }
}

function ownedCreatedWorktree(
  worktree: CreatePaseoWorktreeWorkflowResult | null,
): CreatePaseoWorktreeWorkflowResult | null {
  return worktree?.created === true ? worktree : null;
}

function requireExecutionWorkspaceId(
  record: Pick<StoredAgentRecord, "id" | "workspaceId">,
): string {
  if (!record.workspaceId) {
    throw new Error(`Hub execution agent ${record.id} has no workspaceId`);
  }
  return record.workspaceId;
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
