import { stat } from "node:fs/promises";
import type { Logger } from "pino";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import type { AgentModelDefinition } from "../agent/agent-sdk-types.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowFn } from "../worktree-session.js";
import { areEquivalentPaths } from "../../utils/path.js";
import type {
  WorkflowRuntimeAdapter,
  WorkflowTurnReconciliation,
  WorkflowTurnRequest,
  WorkflowTurnResult,
} from "./runtime-adapter.js";
import type { JsonObject, WorkflowCallerContext } from "./spec.js";
import type { WorkflowWorkspace } from "./state.js";

interface PaseoWorkflowRuntimeAdapterOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  providerSnapshotManager: ProviderSnapshotManager;
  workspaceRegistry: WorkspaceRegistry;
  createAgent: BoundCreateAgentCommand;
  createPaseoWorktree: CreatePaseoWorktreeWorkflowFn;
  logger: Logger;
}

export class PaseoWorkflowRuntimeAdapter implements WorkflowRuntimeAdapter {
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly createPaseoWorktree: CreatePaseoWorktreeWorkflowFn;
  private readonly logger: Logger;
  private readonly resumedNativeTurns = new Map<string, string>();

  constructor(options: PaseoWorkflowRuntimeAdapterOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.providerSnapshotManager = options.providerSnapshotManager;
    this.workspaceRegistry = options.workspaceRegistry;
    this.createAgent = options.createAgent;
    this.createPaseoWorktree = options.createPaseoWorktree;
    this.logger = options.logger;
  }

  async resolveCallerContext(input: {
    workspaceId?: string;
    agentId?: string;
  }): Promise<WorkflowCallerContext> {
    if (input.agentId) {
      const agent = await this.loadAgent(input.agentId);
      if (input.workspaceId && agent.workspaceId && input.workspaceId !== agent.workspaceId) {
        throw new Error(`agent ${input.agentId} does not belong to workspace ${input.workspaceId}`);
      }
      return {
        workspaceId: agent.workspaceId ?? input.workspaceId,
        worktreePath: agent.cwd,
        agentId: agent.id,
      };
    }
    if (input.workspaceId) {
      const workspace = await this.requireWorkspace(input.workspaceId);
      return { workspaceId: workspace.workspaceId, worktreePath: workspace.cwd };
    }
    return {};
  }

  async validateMaterializedSpec(spec: JsonObject): Promise<void> {
    const cwd = rootCwd(spec);
    const stats = await stat(cwd);
    if (!stats.isDirectory()) throw new Error(`workflow cwd is not a directory: ${cwd}`);
    const agents = objectValue(spec.agents, "agents");
    for (const [role, rawDeclaration] of Object.entries(agents)) {
      const declaration = objectValue(rawDeclaration, `agents.${role}`);
      const create = objectValue(declaration.createAgent, `agents.${role}.createAgent`);
      await this.validateAgentCreate(create, cwd, `agents.${role}.createAgent`);
    }
  }

  async ensureWorkspace(input: {
    runId: string;
    instanceId: string;
    create: JsonObject;
    namingPrompt: string | null;
  }): Promise<WorkflowWorkspace> {
    const target = objectValue(input.create.target, "createWorktree.target");
    const mode = stringValue(target.mode, "createWorktree.target.mode");
    const stableSlug = `workflow-${input.runId.slice(4, 16)}-${input.instanceId}`.toLowerCase();
    const result = await this.createPaseoWorktree({
      cwd: stringValue(input.create.cwd, "createWorktree.cwd"),
      worktreeSlug: stableSlug,
      ...(typeof input.create.name === "string" ? { title: input.create.name } : {}),
      ...(input.namingPrompt
        ? { firstAgentContext: { prompt: input.namingPrompt, attachments: [] } }
        : {}),
      ...worktreeTarget(mode, target),
    });
    return {
      workspaceId: result.workspace.workspaceId,
      cwd: result.workspace.cwd,
      name: result.workspace.title ?? result.workspace.displayName,
      ...(result.workspace.branch ? { branch: result.workspace.branch } : {}),
    };
  }

  async resolveBoundWorkspace(input: {
    workspaceId: string;
    worktreePath: string;
  }): Promise<WorkflowWorkspace> {
    const workspace = await this.requireWorkspace(input.workspaceId);
    if (!areEquivalentPaths(workspace.cwd, input.worktreePath)) {
      throw new Error(`workspace ${input.workspaceId} does not own worktree ${input.worktreePath}`);
    }
    return {
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      name: workspace.title ?? workspace.displayName,
      ...(workspace.branch ? { branch: workspace.branch } : {}),
    };
  }

  async ensureAgent(input: {
    runId: string;
    workflowName: string;
    instanceId: string;
    flow: string;
    role: string;
    agentKey: string;
    create: JsonObject;
    workspace: WorkflowWorkspace;
    existingAgentId: string | null;
  }): Promise<string> {
    if (input.existingAgentId) {
      const existing = await this.loadAgent(input.existingAgentId);
      this.assertAgentWorkspace(existing, input.workspace);
      return existing.id;
    }
    const labels = workflowAgentLabels(input);
    const stored = (await this.agentStorage.list()).find(
      (record) =>
        !record.archivedAt &&
        Object.entries(labels).every(([key, value]) => record.labels[key] === value),
    );
    if (stored) {
      const existing = await this.loadAgent(stored.id);
      this.assertAgentWorkspace(existing, input.workspace);
      return existing.id;
    }
    const settings = isObject(input.create.settings) ? input.create.settings : {};
    const provider = providerModelValue(input.create);
    const result = await this.createAgent({
      kind: "mcp",
      provider,
      title: stringValue(input.create.title, "createAgent.title"),
      config: {
        ...(typeof settings.modeId === "string" ? { modeId: settings.modeId } : {}),
        ...(typeof settings.thinkingOptionId === "string"
          ? { thinkingOptionId: settings.thinkingOptionId }
          : {}),
        ...(isObject(settings.featureValues) ? { featureValues: settings.featureValues } : {}),
      },
      cwd: input.workspace.cwd,
      workspaceId: input.workspace.workspaceId,
      labels,
      background: true,
      notifyOnFinish: false,
      internal: false,
      detached: true,
    });
    return result.snapshot.id;
  }

  async waitUntilAgentIdle(agentId: string): Promise<void> {
    await this.loadAgent(agentId);
    while (this.isAgentBusy(agentId)) {
      await this.waitForAgentStateChange(agentId);
    }
  }

  async startTurn(
    request: WorkflowTurnRequest,
    onStarted: (nativeTurnId: string) => Promise<void>,
  ): Promise<WorkflowTurnResult> {
    await this.loadAgent(request.agentId);
    let nativeTurnId: string | null = null;
    let resolveStarted!: (turnId: string) => void;
    const started = new Promise<string>((resolve) => {
      resolveStarted = resolve;
    });
    const unsubscribe = this.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_state" && event.agent.activeForegroundTurnId && !nativeTurnId) {
          nativeTurnId = event.agent.activeForegroundTurnId;
          resolveStarted(nativeTurnId);
        }
      },
      { agentId: request.agentId },
    );
    const settled = this.agentManager
      .runAgent(request.agentId, request.prompt, {
        clientMessageId: request.clientMessageId,
      })
      .then(
        (result) => ({
          kind: "result" as const,
          result: {
            agentId: request.agentId,
            nativeTurnId,
            status: result.canceled ? ("canceled" as const) : ("completed" as const),
            lastMessage: result.finalText,
            lastError: null,
          },
        }),
        (error) => ({
          kind: "result" as const,
          result: {
            agentId: request.agentId,
            nativeTurnId,
            status: "failed" as const,
            lastMessage: "",
            lastError: errorMessage(error),
          },
        }),
      );
    try {
      const first = await Promise.race([
        started.then((turnId) => ({ kind: "started" as const, turnId })),
        settled,
      ]);
      if (first.kind === "started") {
        await onStarted(first.turnId);
        return (await settled).result;
      }
      return first.result;
    } finally {
      unsubscribe();
    }
  }

  async reconcileTurn(input: {
    agentId: string;
    nativeTurnId: string | null;
    clientMessageId: string;
  }): Promise<WorkflowTurnReconciliation> {
    if (input.nativeTurnId) {
      // A restored provider may call a native Paseo tool as soon as its session
      // reconnects. Publish the persisted identity before loading that session;
      // getActiveTurnId still prefers a different live foreground turn.
      this.resumedNativeTurns.set(input.agentId, input.nativeTurnId);
    }
    let agent = await this.loadAgent(input.agentId);
    if (input.nativeTurnId) {
      await this.waitForResumedTurn(input.agentId, input.clientMessageId);
    }
    agent = this.agentManager.getAgent(input.agentId) ?? agent;
    const activeTurnId = agent.activeForegroundTurnId;
    if (activeTurnId && (!input.nativeTurnId || input.nativeTurnId === activeTurnId)) {
      const result = this.withResumedTurnCleanup(
        input.agentId,
        input.nativeTurnId,
        this.waitForTurnResult(input.agentId, activeTurnId, input.clientMessageId),
      );
      return {
        state: "active",
        nativeTurnId: activeTurnId,
        result,
      };
    }
    if (
      input.nativeTurnId &&
      this.isAgentBusy(input.agentId) &&
      (await this.hasSubmittedWorkflowTurn(input.agentId, input.clientMessageId))
    ) {
      const result = this.withResumedTurnCleanup(
        input.agentId,
        input.nativeTurnId,
        this.waitForTurnResult(input.agentId, input.nativeTurnId, input.clientMessageId, true),
      );
      return {
        state: "active",
        nativeTurnId: input.nativeTurnId,
        result,
      };
    }
    const historical = await this.findHistoricalTurnResult(
      input.agentId,
      input.nativeTurnId,
      input.clientMessageId,
    );
    this.clearResumedTurn(input.agentId, input.nativeTurnId);
    return historical ? { state: "completed", result: historical } : { state: "missing" };
  }

  getActiveTurnId(agentId: string): string | null {
    return (
      this.agentManager.getAgent(agentId)?.activeForegroundTurnId ??
      this.resumedNativeTurns.get(agentId) ??
      null
    );
  }

  private async validateAgentCreate(create: JsonObject, cwd: string, path: string): Promise<void> {
    const { provider, model } = providerAndModel(create);
    const entry = await this.providerSnapshotManager.getProvider({
      provider,
      cwd,
      wait: true,
    });
    if (entry.status !== "ready") {
      throw new Error(`${path}.provider: ${entry.error ?? `${provider} is unavailable`}`);
    }
    const requestedModel = model
      ? (entry.models ?? []).find((candidate) => candidate.id === model)
      : undefined;
    if (model && (entry.models?.length ?? 0) > 0 && !requestedModel) {
      throw new Error(`${path}.model: model ${model} is not available for ${provider}`);
    }
    const settings = isObject(create.settings) ? create.settings : {};
    const requestedMode = firstString(settings.modeId, settings.mode);
    await this.providerSnapshotManager.resolveCreateConfig({
      cwd,
      provider,
      requestedMode,
      featureValues: isObject(settings.featureValues) ? settings.featureValues : undefined,
      parent: null,
      unattended: false,
    });
    const thinking = firstString(settings.thinkingOptionId, settings.thinking);
    validateThinkingOption(requestedModel, thinking, path);
  }

  private async loadAgent(agentId: string): Promise<ManagedAgent> {
    return ensureAgentLoaded(agentId, {
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      logger: this.logger,
    });
  }

  private async requireWorkspace(workspaceId: string) {
    const workspace = await this.workspaceRegistry.get(workspaceId);
    if (!workspace || workspace.archivedAt) {
      throw new Error(`workspace not found: ${workspaceId}`);
    }
    return workspace;
  }

  private assertAgentWorkspace(agent: ManagedAgent, workspace: WorkflowWorkspace): void {
    if (
      agent.workspaceId !== workspace.workspaceId ||
      !areEquivalentPaths(agent.cwd, workspace.cwd)
    ) {
      throw new Error(`agent ${agent.id} does not belong to workspace ${workspace.workspaceId}`);
    }
  }

  private isAgentBusy(agentId: string): boolean {
    const agent = this.agentManager.getAgent(agentId);
    return Boolean(
      agent &&
      (agent.lifecycle === "running" ||
        agent.lifecycle === "initializing" ||
        agent.activeForegroundTurnId ||
        this.agentManager.hasInFlightRun(agentId)),
    );
  }

  private async waitForAgentStateChange(agentId: string): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      let unsubscribe: () => void = () => undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve();
      };
      unsubscribe = this.agentManager.subscribe(
        (event) => {
          if (event.type !== "agent_state") return;
          finish();
        },
        { agentId, replayState: false },
      );
      if (!this.isAgentBusy(agentId)) finish();
    });
  }

  private async waitForTurnResult(
    agentId: string,
    nativeTurnId: string,
    clientMessageId: string,
    autonomous = false,
  ): Promise<WorkflowTurnResult> {
    while (
      autonomous
        ? this.isAgentBusy(agentId)
        : this.agentManager.getAgent(agentId)?.activeForegroundTurnId === nativeTurnId
    ) {
      await this.waitForAgentStateChange(agentId);
    }
    return (
      (await this.findHistoricalTurnResult(agentId, nativeTurnId, clientMessageId)) ?? {
        agentId,
        nativeTurnId,
        status: "failed",
        lastMessage: "",
        lastError: "native workflow turn ended without durable timeline evidence",
      }
    );
  }

  private async hasSubmittedWorkflowTurn(
    agentId: string,
    clientMessageId: string,
  ): Promise<boolean> {
    const rows = await this.agentManager.getTimelineRows(agentId);
    return rows.some(
      (row) => row.item.type === "user_message" && row.item.clientMessageId === clientMessageId,
    );
  }

  private async waitForResumedTurn(agentId: string, clientMessageId: string): Promise<void> {
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      if (
        this.isAgentBusy(agentId) &&
        (await this.hasSubmittedWorkflowTurn(agentId, clientMessageId))
      ) {
        return;
      }
      await this.waitForAgentUpdate(agentId, Math.min(100, deadline - Date.now()));
    }
  }

  private async waitForAgentUpdate(agentId: string, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return;
    let unsubscribe: () => void = () => undefined;
    const update = new Promise<void>((resolve) => {
      unsubscribe = this.agentManager.subscribe(
        () => {
          unsubscribe();
          resolve();
        },
        { agentId, replayState: false },
      );
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([update, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
    }
  }

  private withResumedTurnCleanup(
    agentId: string,
    nativeTurnId: string | null,
    result: Promise<WorkflowTurnResult>,
  ): Promise<WorkflowTurnResult> {
    return result.finally(() => this.clearResumedTurn(agentId, nativeTurnId));
  }

  private clearResumedTurn(agentId: string, nativeTurnId: string | null): void {
    if (nativeTurnId && this.resumedNativeTurns.get(agentId) === nativeTurnId) {
      this.resumedNativeTurns.delete(agentId);
    }
  }

  private async findHistoricalTurnResult(
    agentId: string,
    nativeTurnId: string | null,
    clientMessageId: string,
  ): Promise<WorkflowTurnResult | null> {
    const rows = await this.agentManager.getTimelineRows(agentId);
    const start = rows.findLastIndex(
      (row) => row.item.type === "user_message" && row.item.clientMessageId === clientMessageId,
    );
    if (start < 0) return null;
    const assistant = rows
      .slice(start + 1)
      .findLast((row) => row.item.type === "assistant_message");
    const lastMessage = assistant?.item.type === "assistant_message" ? assistant.item.text : "";
    const agent = this.agentManager.getAgent(agentId);
    return {
      agentId,
      nativeTurnId,
      status: agent?.lifecycle === "error" ? "failed" : "completed",
      lastMessage,
      lastError: agent?.lastError ?? null,
    };
  }
}

function workflowAgentLabels(input: {
  runId: string;
  workflowName: string;
  instanceId: string;
  flow: string;
  role: string;
  agentKey: string;
}): Record<string, string> {
  return {
    "paseo.workflow.name": input.workflowName,
    "paseo.workflow.run": input.runId,
    "paseo.workflow.instance": input.instanceId,
    "paseo.workflow.flow": input.flow,
    "paseo.workflow.agent": input.role,
    "paseo.workflow.agent-key": input.agentKey,
  };
}

function rootCwd(spec: JsonObject): string {
  if (isObject(spec.bindings) && typeof spec.bindings.worktree === "string") {
    return spec.bindings.worktree;
  }
  const workspace = objectValue(spec.workspace, "workspace");
  const create = objectValue(workspace.createWorktree, "workspace.createWorktree");
  return stringValue(create.cwd, "workspace.createWorktree.cwd");
}

function worktreeTarget(mode: string, target: JsonObject): JsonObject {
  if (mode === "branch-off") {
    return {
      action: "branch-off",
      ...(typeof target.newBranch === "string" ? { branchName: target.newBranch } : {}),
      ...(typeof target.base === "string" ? { refName: target.base } : {}),
    };
  }
  if (mode === "checkout-branch") {
    return { action: "checkout", refName: stringValue(target.branch, "target.branch") };
  }
  return {
    action: "checkout",
    githubPrNumber: numberValue(target.prNumber, "target.prNumber"),
  };
}

function providerModelValue(create: JsonObject): string {
  const { provider, model } = providerAndModel(create);
  return model ? `${provider}/${model}` : provider;
}

function providerAndModel(create: JsonObject): { provider: string; model: string | undefined } {
  const value = stringValue(create.provider, "createAgent.provider");
  const slash = value.indexOf("/");
  if (slash >= 0) {
    return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
  }
  return {
    provider: value,
    model: typeof create.model === "string" ? create.model : undefined,
  };
}

function validateThinkingOption(
  model: AgentModelDefinition | undefined,
  thinking: string | undefined,
  path: string,
): void {
  if (!thinking || !model?.thinkingOptions?.length) return;
  if (!model.thinkingOptions.some((option) => option.id === thinking)) {
    throw new Error(`${path}.settings.thinkingOptionId: ${thinking} is not available`);
  }
}

function objectValue(value: unknown, path: string): JsonObject {
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${path} must be a string`);
  return value;
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== "number") throw new Error(`${path} must be a number`);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
