import { randomUUID } from "node:crypto";
import type {
  WorkflowEventRecord,
  WorkflowRunDetails,
  WorkflowRunSummary,
  WorkflowSpecSummary,
  WorkflowValidationResult,
} from "@getpaseo/protocol/workflow/types";
import Ajv2020 from "ajv/dist/2020.js";
import type {
  WorkflowRuntimeAdapter,
  WorkflowTurnReconciliation,
  WorkflowTurnResult,
} from "./runtime-adapter.js";
import { renderPrompt, renderValue } from "./render.js";
import {
  formatValidationIssues,
  type JsonObject,
  materializeWorkflowSpec,
  validateWorkflowTemplate,
} from "./spec.js";
import {
  type WorkflowAcceptedEvent,
  type WorkflowActiveTurn,
  type WorkflowInstance,
  type WorkflowRoleState,
  type WorkflowRunState,
  WorkflowRunStateSchema,
  type WorkflowWorkspace,
} from "./state.js";
import { WorkflowStorage } from "./storage.js";

const Ajv2020Constructor = Ajv2020 as unknown as {
  new (options?: { allErrors?: boolean; strict?: boolean }): {
    compile: (schema: unknown) => {
      (value: unknown): boolean;
      errors?: Array<{ instancePath?: string; message?: string }> | null;
    };
  };
};

interface WorkflowServiceOptions {
  storage: WorkflowStorage;
  adapter: WorkflowRuntimeAdapter;
}

interface StartWorkflowRunInput {
  workflowId: string;
  parameters?: JsonObject;
  context?: {
    workspaceId?: string;
    agentId?: string;
  };
}

interface EmitWorkflowEventInput {
  callerAgentId: string;
  event: string;
  message?: string;
  data?: unknown;
}

interface Transaction {
  state: WorkflowRunState;
  events: WorkflowEventRecord[];
  acceptedEvents: Array<{
    workflowTurnId: string;
    event: WorkflowAcceptedEvent;
  }>;
}

export class WorkflowService {
  private readonly storage: WorkflowStorage;
  private readonly adapter: WorkflowRuntimeAdapter;
  private readonly drivePromises = new Map<string, Promise<void>>();
  private readonly turnPromises = new Map<string, Promise<void>>();
  private readonly lockTails = new Map<string, Promise<void>>();
  private readonly limitTimers = new Map<string, NodeJS.Timeout>();
  private initialized = false;
  private disposed = false;

  constructor(options: WorkflowServiceOptions) {
    this.storage = options.storage;
    this.adapter = options.adapter;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.storage.initialize();
    this.initialized = true;
    for (const run of await this.storage.listRuns()) {
      if (!run.legacy && ["queued", "running", "stopping"].includes(run.status)) {
        this.kick(run.id);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.limitTimers.values()) clearTimeout(timer);
    this.limitTimers.clear();
  }

  async listSpecs(): Promise<WorkflowSpecSummary[]> {
    this.requireInitialized();
    return this.storage.listSpecs();
  }

  async getSpec(id: string): Promise<JsonObject> {
    this.requireInitialized();
    return this.storage.getSpec(id);
  }

  validateSpec(spec: unknown): WorkflowValidationResult {
    return validateWorkflowTemplate(spec);
  }

  async saveSpec(spec: unknown): Promise<{
    spec: JsonObject;
    summary: WorkflowSpecSummary;
    validation: WorkflowValidationResult;
  }> {
    this.requireInitialized();
    const validation = validateWorkflowTemplate(spec, "user");
    if (!validation.valid || !validation.summary) {
      throw new Error(formatValidationIssues(validation.issues));
    }
    const saved = await this.storage.saveUserSpec(spec);
    const summary = (await this.storage.listSpecs()).find(
      (candidate) => candidate.id === validation.summary?.id,
    );
    if (!summary) throw new Error("saved workflow spec could not be reloaded");
    return { spec: saved, summary, validation: { ...validation, summary } };
  }

  async startRun(input: StartWorkflowRunInput): Promise<WorkflowRunSummary> {
    this.requireInitialized();
    const template = await this.storage.getSpec(input.workflowId);
    const caller = await this.adapter.resolveCallerContext(input.context ?? {});
    const { spec } = materializeWorkflowSpec(template, input.parameters ?? {}, caller);
    const runId = createRunId();
    const now = new Date().toISOString();
    const root = createRootInstance(spec);
    const state: WorkflowRunState = {
      schemaVersion: "paseo.workflows.run.v0.2",
      runId,
      workflow: { id: stringField(spec, "name"), name: stringField(spec, "name") },
      status: "queued",
      reason: null,
      stopRequested: false,
      pendingTerminal: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      loop: { iteration: 0, elapsedSeconds: 0 },
      eventSeq: 1,
      nextInstance: 1,
      instances: { root },
      result: null,
    };
    await this.storage.createRun(runId, spec, state as unknown as JsonObject);
    await this.storage.appendEvent(runId, {
      seq: 1,
      timestamp: now,
      type: "run_queued",
      details: { runId, workflowId: input.workflowId },
    });
    this.kick(runId);
    return (await this.storage.inspectRun(runId)).run;
  }

  async listRuns(): Promise<WorkflowRunSummary[]> {
    this.requireInitialized();
    return this.storage.listRuns();
  }

  async inspectRun(runId: string): Promise<WorkflowRunDetails> {
    this.requireInitialized();
    return this.storage.inspectRun(runId);
  }

  async logs(
    runId: string,
    afterSeq = 0,
  ): Promise<{ run: WorkflowRunSummary; entries: WorkflowEventRecord[]; nextCursor: number }> {
    const details = await this.inspectRun(runId);
    const entries = details.events.filter((event) => event.seq > afterSeq);
    return {
      run: details.run,
      entries,
      nextCursor: entries.at(-1)?.seq ?? afterSeq,
    };
  }

  async stopRun(runId: string): Promise<WorkflowRunSummary> {
    this.requireInitialized();
    await this.transact(runId, (tx) => {
      if (isTerminal(tx.state.status)) return;
      tx.state.stopRequested = true;
      tx.state.status = hasActiveTurns(tx.state) ? "stopping" : "stopped";
      tx.state.reason = "requested";
      if (tx.state.status === "stopped") tx.state.completedAt = new Date().toISOString();
      queueEvent(tx, {
        type: "stop_requested",
        details: { activeTurns: countActiveTurns(tx.state) },
      });
      if (tx.state.status === "stopped") {
        queueEvent(tx, { type: "run_stopped", details: { reason: "requested" } });
      }
    });
    this.kick(runId);
    return (await this.storage.inspectRun(runId)).run;
  }

  async resumeRun(runId: string): Promise<WorkflowRunSummary> {
    this.requireInitialized();
    const existing = await this.storage.inspectRun(runId);
    if (existing.run.legacy) {
      throw new Error(`legacy workflow runs are inspectable but cannot be resumed: ${runId}`);
    }
    await this.transact(runId, (tx) => {
      if (tx.state.status === "complete") {
        throw new Error(`completed workflow runs cannot be resumed: ${runId}`);
      }
      if (tx.state.status !== "stopped" && tx.state.status !== "failed") {
        throw new Error(`workflow run is not stopped: ${runId}`);
      }
      tx.state.status = "running";
      tx.state.reason = null;
      tx.state.stopRequested = false;
      tx.state.pendingTerminal = null;
      tx.state.completedAt = null;
      queueEvent(tx, { type: "run_resumed" });
    });
    this.kick(runId);
    return (await this.storage.inspectRun(runId)).run;
  }

  async emitEvent(input: EmitWorkflowEventInput): Promise<void> {
    this.requireInitialized();
    const candidates = (await this.storage.listRuns()).filter(
      (run) =>
        !run.legacy &&
        ["running", "stopping"].includes(run.status) &&
        run.agentIds.includes(input.callerAgentId),
    );
    const matches: string[] = [];
    for (const candidate of candidates) {
      const state = parseState(await this.storage.readState(candidate.id));
      if (findActiveTurnForAgent(state, input.callerAgentId)) matches.push(candidate.id);
    }
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `caller ${input.callerAgentId} is not an active workflow turn`
          : `caller ${input.callerAgentId} matches multiple active workflow turns`,
      );
    }
    const runId = matches[0];
    await this.getRunSpec(runId);
    await this.transact(runId, (tx) => {
      const active = findActiveTurnForAgent(tx.state, input.callerAgentId);
      if (!active) {
        throw new Error(`caller ${input.callerAgentId} is not an active workflow turn`);
      }
      const { turn } = active;
      const nativeTurnId = this.adapter.getActiveTurnId(input.callerAgentId);
      if (turn.phase === "launching" && nativeTurnId) {
        turn.nativeTurnId = nativeTurnId;
        turn.phase = "running";
      }
      if (
        turn.phase !== "running" ||
        !turn.nativeTurnId ||
        !nativeTurnId ||
        nativeTurnId !== turn.nativeTurnId
      ) {
        throw new Error("workflow event caller does not own the active native turn");
      }
      if (turn.acceptedEvent) {
        throw new Error(`workflow event already accepted for ${turn.workflowTurnId}`);
      }
      if (!turn.allowedEvents.includes(input.event)) {
        throw new Error(`event ${input.event} is not allowed in this workflow state`);
      }
      const data = input.data ?? {};
      validateEventData(this.currentEventSchema(tx.state, active.instance, input.event), data);
      const accepted: WorkflowAcceptedEvent = {
        event: input.event,
        message: input.message ?? "",
        data,
        acceptedAt: new Date().toISOString(),
        nativeTurnId,
      };
      turn.acceptedEvent = accepted;
      tx.acceptedEvents.push({ workflowTurnId: turn.workflowTurnId, event: accepted });
      queueEvent(tx, {
        type: "event_accepted",
        instanceId: active.instance.id,
        flow: active.instance.flow,
        state: active.instance.state,
        agent: turn.agent,
        agentId: input.callerAgentId,
        event: input.event,
        message: accepted.message,
        data,
      });
    });
  }

  async waitForRunTerminal(runId: string, timeoutMs = 10_000): Promise<WorkflowRunSummary> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const run = (await this.storage.inspectRun(runId)).run;
      if (isTerminal(run.status)) return run;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for workflow run ${runId}`);
  }

  private kick(runId: string): void {
    if (this.disposed || this.drivePromises.has(runId)) return;
    const promise = Promise.resolve()
      .then(() => this.drive(runId))
      .catch((error) => this.failRun(runId, error))
      .finally(() => {
        this.drivePromises.delete(runId);
      });
    this.drivePromises.set(runId, promise);
  }

  private async drive(runId: string): Promise<void> {
    while (!this.disposed) {
      const state = parseState(await this.storage.readState(runId));
      if (isTerminal(state.status)) {
        this.clearLimitTimer(runId);
        return;
      }
      if (state.status === "queued") {
        await this.transact(runId, (tx) => {
          tx.state.status = "running";
          tx.state.startedAt ??= new Date().toISOString();
          queueEvent(tx, { type: "run_started" });
        });
        continue;
      }
      await this.updateElapsedAndLimits(runId);
      const current = parseState(await this.storage.readState(runId));
      if (isTerminal(current.status)) return;
      if (current.stopRequested && !hasActiveTurns(current)) {
        await this.finishStopped(runId);
        return;
      }
      const orphan = Object.values(current.instances).find(
        (instance) =>
          instance.status === "waiting-turn" &&
          instance.activeTurn &&
          !this.turnPromises.has(turnKey(runId, instance.activeTurn.workflowTurnId)),
      );
      if (orphan?.activeTurn) {
        this.attachTurn(runId, orphan.id, orphan.activeTurn);
        continue;
      }
      if (current.stopRequested) return;
      const runnable = Object.values(current.instances).find((instance) =>
        ["provisioning", "runnable"].includes(instance.status),
      );
      if (!runnable) return;
      if (runnable.status === "provisioning") {
        await this.provisionInstance(runId, runnable);
      } else {
        await this.advanceInstance(runId, runnable.id);
      }
    }
  }

  private async updateElapsedAndLimits(runId: string): Promise<void> {
    await this.transact(runId, (tx) => {
      if (!tx.state.startedAt || isTerminal(tx.state.status)) return;
      tx.state.loop.elapsedSeconds = Math.max(
        0,
        Math.floor((Date.now() - Date.parse(tx.state.startedAt)) / 1000),
      );
      const reason = limitReason(tx.state, this.currentSpecLimits(runId));
      if (!reason) return;
      applyLimit(tx, reason);
    });
    await this.scheduleLimitTimer(runId);
  }

  private specCache = new Map<string, JsonObject>();

  private currentSpecLimits(runId: string): JsonObject {
    const spec = this.specCache.get(runId);
    return spec && isObject(spec.limits) ? spec.limits : {};
  }

  private async getRunSpec(runId: string): Promise<JsonObject> {
    const cached = this.specCache.get(runId);
    if (cached) return cached;
    const spec = (await this.storage.inspectRun(runId)).spec;
    this.specCache.set(runId, spec);
    return spec;
  }

  private async scheduleLimitTimer(runId: string): Promise<void> {
    this.clearLimitTimer(runId);
    const state = parseState(await this.storage.readState(runId));
    const spec = await this.getRunSpec(runId);
    const limits = isObject(spec.limits) ? spec.limits : {};
    if (!state.startedAt || typeof limits.maxRuntime !== "string" || isTerminal(state.status))
      return;
    const remaining =
      durationSeconds(limits.maxRuntime) * 1000 - (Date.now() - Date.parse(state.startedAt));
    const timer = setTimeout(() => this.kick(runId), Math.max(remaining, 1));
    timer.unref();
    this.limitTimers.set(runId, timer);
  }

  private clearLimitTimer(runId: string): void {
    const timer = this.limitTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.limitTimers.delete(runId);
  }

  private async provisionInstance(runId: string, instance: WorkflowInstance): Promise<void> {
    const spec = await this.getRunSpec(runId);
    if (instance.id === "root") {
      await this.adapter.validateMaterializedSpec(spec, {});
    }
    const request = instance.workspaceRequest;
    if (!request) throw new Error(`instance ${instance.id} has no workspace request`);
    let workspace: WorkflowWorkspace;
    if (request.kind === "bound") {
      workspace = await this.adapter.resolveBoundWorkspace({
        workspaceId: String(request.workspaceId),
        worktreePath: String(request.worktreePath),
      });
    } else {
      const create = objectField(request, "create");
      workspace = await this.adapter.ensureWorkspace({
        runId,
        instanceId: instance.id,
        create,
        namingPrompt: this.workspaceNamingPrompt(spec, instance),
      });
    }
    await this.transact(runId, (tx) => {
      const current = requireInstance(tx.state, instance.id);
      if (current.status !== "provisioning") return;
      current.workspace = workspace;
      current.workspaceRequest = null;
      current.status = "runnable";
      queueEvent(tx, {
        type: "workspace_ready",
        instanceId: current.id,
        flow: current.flow,
        details: { workspaceId: workspace.workspaceId, cwd: workspace.cwd },
      });
    });
  }

  private workspaceNamingPrompt(spec: JsonObject, instance: WorkflowInstance): string | null {
    const flow = flowDefinition(spec, instance.flow);
    const state = stateDefinition(flow, instance.state);
    if (!isObject(state.turn)) return null;
    const promptName = String(state.turn.prompt);
    const prompts = objectField(spec, "prompts");
    const template = prompts[promptName];
    if (typeof template !== "string") return null;
    try {
      return renderPrompt(template, buildContext(spec, createPreviewState(spec), instance));
    } catch {
      return `${String(spec.description)}\n\nWorkflow inputs: ${JSON.stringify(instance.inputs)}`;
    }
  }

  private async advanceInstance(runId: string, instanceId: string): Promise<void> {
    const spec = await this.getRunSpec(runId);
    const state = parseState(await this.storage.readState(runId));
    const instance = requireInstance(state, instanceId);
    const definition = stateDefinition(flowDefinition(spec, instance.flow), instance.state);
    if (isObject(definition.turn)) {
      await this.prepareTurn(runId, instanceId, spec);
      return;
    }
    if (isObject(definition.call)) {
      await this.startCall(runId, instanceId, spec, definition);
      return;
    }
    if (isObject(definition.map)) {
      await this.startMap(runId, instanceId, spec, definition);
      return;
    }
    if (isObject(definition.return)) {
      await this.returnInstance(runId, instanceId, spec, definition);
      return;
    }
    await this.stopFromState(runId, instanceId, spec, definition);
  }

  private async prepareTurn(runId: string, instanceId: string, spec: JsonObject): Promise<void> {
    let prepared: WorkflowActiveTurn | null = null;
    await this.transact(runId, async (tx) => {
      const instance = requireInstance(tx.state, instanceId);
      if (instance.status !== "runnable") return;
      const definition = stateDefinition(flowDefinition(spec, instance.flow), instance.state);
      const turn = objectField(definition, "turn");
      const role = String(turn.agent);
      const promptName = String(turn.prompt);
      const emits = objectField(turn, "emits");
      const repair = instance.repair;
      const limits = isObject(spec.limits) ? spec.limits : {};
      if (
        typeof limits.maxIterations === "number" &&
        tx.state.loop.iteration >= limits.maxIterations
      ) {
        applyLimit(tx, "max_iterations");
        return;
      }
      const iteration = tx.state.loop.iteration + 1;
      const context = buildContext(spec, tx.state, instance, iteration);
      const prompt = repair
        ? repairPrompt(repair.reason, emits)
        : `${renderPrompt(stringValue(objectField(spec, "prompts")[promptName]), context)}${routingPrompt(emits)}`;
      const workflowTurnId = `wft_${randomUUID().replaceAll("-", "")}`;
      const promptPath = `${String(iteration).padStart(4, "0")}-${safeName(instance.id)}-${safeName(role)}-${safeName(promptName)}.txt`;
      await this.storage.writePrompt(runId, {
        name: promptPath,
        workflowTurnId,
        instanceId,
        agentId: repair?.agentId ?? instance.agents[role]?.agentId ?? null,
        createdAt: new Date().toISOString(),
        content: prompt,
      });
      prepared = {
        workflowTurnId,
        clientMessageId: workflowTurnId,
        iteration,
        instanceId,
        flow: instance.flow,
        state: instance.state,
        agent: role,
        prompt: promptName,
        promptPath,
        attempt: repair?.attempt ?? 1,
        phase: "queued",
        agentId: repair?.agentId ?? null,
        nativeTurnId: null,
        allowedEvents: Object.keys(emits),
        acceptedEvent: null,
        createdAt: new Date().toISOString(),
      };
      instance.activeTurn = prepared;
      instance.repair = null;
      instance.status = "waiting-turn";
      tx.state.loop.iteration = iteration;
    });
    if (prepared) this.attachTurn(runId, instanceId, prepared);
  }

  private attachTurn(runId: string, instanceId: string, turn: WorkflowActiveTurn): void {
    const key = turnKey(runId, turn.workflowTurnId);
    if (this.disposed || this.turnPromises.has(key)) return;
    const promise = this.runOrReconcileTurn(runId, instanceId, turn)
      .catch((error) =>
        this.completeTurn(runId, instanceId, {
          agentId: turn.agentId ?? "",
          nativeTurnId: turn.nativeTurnId,
          status: "failed",
          lastMessage: "",
          lastError: errorMessage(error),
        }),
      )
      .finally(() => {
        this.turnPromises.delete(key);
        if (!this.disposed) this.kick(runId);
      });
    this.turnPromises.set(key, promise);
  }

  private async runOrReconcileTurn(
    runId: string,
    instanceId: string,
    turn: WorkflowActiveTurn,
  ): Promise<void> {
    if (turn.agentId && turn.phase !== "queued") {
      const reconciliation = await this.adapter.reconcileTurn({
        agentId: turn.agentId,
        nativeTurnId: turn.nativeTurnId,
        clientMessageId: turn.clientMessageId,
      });
      if (reconciliation.state !== "missing") {
        await this.consumeReconciliation(runId, instanceId, reconciliation);
        return;
      }
    }
    const spec = await this.getRunSpec(runId);
    const state = parseState(await this.storage.readState(runId));
    const instance = requireInstance(state, instanceId);
    const current = instance.activeTurn;
    if (!current || current.workflowTurnId !== turn.workflowTurnId || !instance.workspace) return;
    const agentDefinition = objectField(objectField(spec, "agents"), current.agent);
    const roleState = requireRole(instance, current.agent);
    const persistence = String(agentDefinition.persistence);
    const existing = current.agentId ?? (persistence === "reuse-agent" ? roleState.agentId : null);
    const agentId = await this.adapter.ensureAgent({
      runId,
      workflowName: state.workflow.name,
      instanceId,
      flow: instance.flow,
      role: current.agent,
      agentKey:
        persistence === "reuse-agent" ? `${instanceId}:${current.agent}` : current.workflowTurnId,
      create: objectField(agentDefinition, "createAgent"),
      workspace: instance.workspace,
      existingAgentId: existing,
    });
    await this.adapter.waitUntilAgentIdle(agentId);
    await this.transact(runId, (tx) => {
      const active = requireActiveTurn(tx.state, instanceId, turn.workflowTurnId);
      active.agentId = agentId;
      active.phase = "launching";
      const role = requireRole(requireInstance(tx.state, instanceId), active.agent);
      role.agentId = agentId;
      role.status = "running";
    });
    const prompt = (await this.storage.inspectRun(runId)).prompts.find(
      (candidate) => candidate.name === turn.promptPath,
    )?.content;
    if (prompt === undefined) throw new Error(`rendered prompt is missing: ${turn.promptPath}`);
    const result = await this.adapter.startTurn(
      {
        runId,
        workflowTurnId: turn.workflowTurnId,
        clientMessageId: turn.clientMessageId,
        instanceId,
        agentId,
        prompt,
        labels: {
          "paseo.workflow.name": state.workflow.name,
          "paseo.workflow.run": runId,
          "paseo.workflow.instance": instanceId,
          "paseo.workflow.flow": instance.flow,
          "paseo.workflow.agent": turn.agent,
          "paseo.workflow.iteration": String(turn.iteration),
        },
      },
      async (nativeTurnId) => {
        await this.transact(runId, (tx) => {
          const active = requireActiveTurn(tx.state, instanceId, turn.workflowTurnId);
          active.nativeTurnId = nativeTurnId;
          active.phase = "running";
          queueEvent(tx, {
            type: "turn_started",
            instanceId,
            flow: active.flow,
            state: active.state,
            agent: active.agent,
            agentId,
            details: {
              workflowTurnId: active.workflowTurnId,
              nativeTurnId,
              iteration: active.iteration,
              allowedEvents: active.allowedEvents,
            },
          });
        });
      },
    );
    await this.completeTurn(runId, instanceId, result);
  }

  private async consumeReconciliation(
    runId: string,
    instanceId: string,
    reconciliation: Exclude<WorkflowTurnReconciliation, { state: "missing" }>,
  ): Promise<void> {
    if (reconciliation.state === "active") {
      await this.transact(runId, (tx) => {
        const instance = requireInstance(tx.state, instanceId);
        if (!instance.activeTurn) return;
        instance.activeTurn.nativeTurnId = reconciliation.nativeTurnId;
        instance.activeTurn.phase = "running";
      });
      await this.completeTurn(runId, instanceId, await reconciliation.result);
      return;
    }
    await this.completeTurn(runId, instanceId, reconciliation.result);
  }

  private async completeTurn(
    runId: string,
    instanceId: string,
    result: WorkflowTurnResult,
  ): Promise<void> {
    const spec = await this.getRunSpec(runId);
    await this.transact(runId, (tx) => {
      const instance = requireInstance(tx.state, instanceId);
      const turn = instance.activeTurn;
      if (!turn) return;
      if (turn.agentId && result.agentId && turn.agentId !== result.agentId) {
        failState(tx, "active_turn_identity_mismatch");
        return;
      }
      if (turn.nativeTurnId && result.nativeTurnId && turn.nativeTurnId !== result.nativeTurnId) {
        failState(tx, "active_turn_identity_mismatch");
        return;
      }
      const role = requireRole(instance, turn.agent);
      const completedAt = new Date().toISOString();
      const emission =
        result.status === "completed"
          ? turn.acceptedEvent
          : {
              event: "error.agent",
              message: result.lastError ?? result.lastMessage,
              data: { status: result.status },
              acceptedAt: completedAt,
              nativeTurnId: result.nativeTurnId ?? turn.nativeTurnId ?? "unknown",
            };
      role.status = result.status;
      role.lastMessage = result.lastMessage;
      role.turns.push({
        workflowTurnId: turn.workflowTurnId,
        clientMessageId: turn.clientMessageId,
        nativeTurnId: result.nativeTurnId ?? turn.nativeTurnId,
        iteration: turn.iteration,
        attempt: turn.attempt,
        instanceId,
        flow: turn.flow,
        state: turn.state,
        agent: turn.agent,
        agentId: result.agentId || turn.agentId || "",
        status: result.status,
        lastMessage: result.lastMessage,
        lastError: result.lastError,
        promptPath: turn.promptPath,
        emission,
        startedAt: turn.createdAt,
        completedAt,
      });
      instance.activeTurn = null;
      const agentDefinition = objectField(objectField(spec, "agents"), turn.agent);
      if (agentDefinition.persistence === "fresh-agent") role.agentId = null;
      const definition = stateDefinition(flowDefinition(spec, turn.flow), turn.state);
      if (!emission) {
        this.routeProtocolFailure(tx, instance, turn, definition, spec);
      } else {
        transition(tx, instance, definition, emission);
      }
      finalizeRequestedStop(tx);
    });
  }

  private routeProtocolFailure(
    tx: Transaction,
    instance: WorkflowInstance,
    turn: WorkflowActiveTurn,
    definition: JsonObject,
    spec: JsonObject,
  ): void {
    const protocol = isObject(spec.protocol) ? spec.protocol : {};
    const maxAttempts = typeof protocol.maxAttempts === "number" ? protocol.maxAttempts : 3;
    const reason = "The turn ended without one allowed workflow event.";
    if (turn.attempt < maxAttempts) {
      instance.repair = { agentId: turn.agentId ?? "", attempt: turn.attempt + 1, reason };
      instance.status = "runnable";
      queueEvent(tx, {
        type: "protocol_retry",
        instanceId: instance.id,
        agent: turn.agent,
        agentId: turn.agentId ?? undefined,
        details: { attempt: turn.attempt + 1, reason },
      });
      return;
    }
    const emission: WorkflowAcceptedEvent = {
      event: "error.protocol",
      message: reason,
      data: { attempts: maxAttempts },
      acceptedAt: new Date().toISOString(),
      nativeTurnId: turn.nativeTurnId ?? "unknown",
    };
    transition(tx, instance, definition, emission);
  }

  private async startCall(
    runId: string,
    instanceId: string,
    spec: JsonObject,
    definition: JsonObject,
  ): Promise<void> {
    await this.transact(runId, (tx) => {
      const parent = requireInstance(tx.state, instanceId);
      if (parent.status !== "runnable") return;
      const call = objectField(definition, "call");
      const child = spawnChild(tx.state, spec, parent, call, {
        kind: "call",
        instanceId: parent.id,
        state: parent.state,
      });
      parent.status = "waiting-call";
      parent.waiting = { kind: "call", childId: child.id };
      queueEvent(tx, {
        type: "flow_called",
        instanceId: parent.id,
        flow: parent.flow,
        details: { childId: child.id, childFlow: child.flow },
      });
    });
  }

  private async startMap(
    runId: string,
    instanceId: string,
    spec: JsonObject,
    definition: JsonObject,
  ): Promise<void> {
    await this.transact(runId, (tx) => {
      const parent = requireInstance(tx.state, instanceId);
      if (parent.status !== "runnable") return;
      const action = objectField(definition, "map");
      const items = renderValue(action.items, buildContext(spec, tx.state, parent));
      if (!Array.isArray(items)) throw new Error("map.items must render to an array");
      const groupName = stringValue(action.group);
      parent.groups[groupName] = {
        name: groupName,
        state: parent.state,
        as: stringValue(action.as),
        call: objectField(action, "call"),
        concurrency:
          typeof action.concurrency === "number" ? action.concurrency : Math.max(items.length, 1),
        items,
        nextIndex: 0,
        children: [],
        results: {},
      };
      parent.status = "waiting-map";
      parent.waiting = { kind: "map", group: groupName };
      fillMapSlots(tx.state, spec, parent, groupName);
      queueEvent(tx, {
        type: "map_started",
        instanceId: parent.id,
        flow: parent.flow,
        details: {
          group: groupName,
          size: items.length,
          concurrency: parent.groups[groupName].concurrency,
        },
      });
      if (items.length === 0) finishMap(tx, spec, parent, definition, groupName);
    });
  }

  private async returnInstance(
    runId: string,
    instanceId: string,
    spec: JsonObject,
    definition: JsonObject,
  ): Promise<void> {
    await this.transact(runId, (tx) => {
      const instance = requireInstance(tx.state, instanceId);
      const action = objectField(definition, "return");
      instance.result = renderValue(action.output, buildContext(spec, tx.state, instance));
      instance.status = "returned";
      if (instance.id === "root") {
        tx.state.result = instance.result;
        requestTerminal(tx, "complete", "returned");
        return;
      }
      queueEvent(tx, {
        type: "flow_returned",
        instanceId,
        flow: instance.flow,
        data: instance.result,
        details: { parent: instance.parent },
      });
      notifyParent(tx, spec, instance);
    });
  }

  private async stopFromState(
    runId: string,
    instanceId: string,
    spec: JsonObject,
    definition: JsonObject,
  ): Promise<void> {
    await this.transact(runId, (tx) => {
      const instance = requireInstance(tx.state, instanceId);
      const stop = objectField(definition, "stop");
      const reason = String(renderValue(stop.reason, buildContext(spec, tx.state, instance)));
      instance.status = "complete";
      requestTerminal(tx, "complete", reason);
    });
  }

  private currentEventSchema(
    state: WorkflowRunState,
    instance: WorkflowInstance,
    event: string,
  ): unknown {
    const spec = this.specCache.get(state.runId);
    if (!spec) throw new Error(`workflow spec is not loaded: ${state.runId}`);
    const definition = stateDefinition(flowDefinition(spec, instance.flow), instance.state);
    const turn = objectField(definition, "turn");
    const declaration = objectField(objectField(turn, "emits"), event);
    return declaration.dataSchema;
  }

  private async finishStopped(runId: string): Promise<void> {
    await this.transact(runId, (tx) => {
      finalizeRequestedStop(tx);
    });
  }

  private async failRun(runId: string, error: unknown): Promise<void> {
    try {
      await this.transact(runId, (tx) => {
        if (isTerminal(tx.state.status)) return;
        failState(tx, errorMessage(error));
      });
    } catch {
      // The original failure is already the best available diagnostic.
    }
  }

  private async transact<T>(
    runId: string,
    callback: (transaction: Transaction) => T | Promise<T>,
  ): Promise<T> {
    return this.withLock(runId, async () => {
      const state = parseState(await this.storage.readState(runId));
      const transaction: Transaction = { state, events: [], acceptedEvents: [] };
      const result = await callback(transaction);
      state.updatedAt = new Date().toISOString();
      await this.storage.saveState(runId, state as unknown as JsonObject);
      for (const event of transaction.events) {
        await this.storage.appendEvent(runId, event);
      }
      for (const accepted of transaction.acceptedEvents) {
        await this.storage.writeAcceptedEvent(runId, accepted.workflowTurnId, accepted.event);
      }
      return result;
    });
  }

  private async withLock<T>(runId: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.lockTails.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.lockTails.set(runId, tail);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.lockTails.get(runId) === tail) {
        tail.finally(() => {
          if (this.lockTails.get(runId) === tail) this.lockTails.delete(runId);
        });
      }
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("WorkflowService is not initialized");
  }
}

function createRootInstance(spec: JsonObject): WorkflowInstance {
  const entry = stringField(spec, "entry");
  const flow = flowDefinition(spec, entry);
  const bindings = isObject(spec.bindings) ? spec.bindings : {};
  const boundWorkspace =
    typeof bindings.workspace === "string" && typeof bindings.worktree === "string";
  return {
    id: "root",
    flow: entry,
    state: stringField(flow, "initial"),
    status: "provisioning",
    inputs: isObject(spec.inputs) ? spec.inputs : {},
    incoming: { event: "start", message: "", data: {} },
    workspace: null,
    workspaceRequest: boundWorkspace
      ? {
          kind: "bound",
          workspaceId: bindings.workspace,
          worktreePath: bindings.worktree,
        }
      : { kind: "create", create: objectField(objectField(spec, "workspace"), "createWorktree") },
    agents: createRoleStates(spec, isObject(bindings.agents) ? bindings.agents : {}),
    activeTurn: null,
    parent: null,
    waiting: null,
    groups: {},
    task: null,
    result: null,
    repair: null,
  };
}

function createRoleStates(
  spec: JsonObject,
  bindings: JsonObject = {},
): Record<string, WorkflowRoleState> {
  return Object.fromEntries(
    Object.keys(objectField(spec, "agents")).map((name) => [
      name,
      {
        agentId: typeof bindings[name] === "string" ? bindings[name] : null,
        status: "idle",
        lastMessage: "",
        turns: [],
      },
    ]),
  );
}

function spawnChild(
  state: WorkflowRunState,
  spec: JsonObject,
  parent: WorkflowInstance,
  call: JsonObject,
  parentRef: JsonObject,
  extra: JsonObject = {},
): WorkflowInstance {
  const flowName = stringValue(call.flow);
  const flow = flowDefinition(spec, flowName);
  const context = { ...buildContext(spec, state, parent), ...extra };
  const supplied = renderValue(isObject(call.with) ? call.with : {}, context);
  if (!isObject(supplied)) throw new Error("call.with must render to an object");
  const id = `i${state.nextInstance++}`;
  const workspace = childWorkspace(call.workspace, context, parent.workspace);
  const child: WorkflowInstance = {
    id,
    flow: flowName,
    state: stringField(flow, "initial"),
    status: workspace.workspace ? "runnable" : "provisioning",
    inputs: {
      ...(isObject(flow.inputs) ? flow.inputs : {}),
      ...parent.inputs,
      ...supplied,
    },
    incoming: { event: "start", message: "", data: {} },
    workspace: workspace.workspace,
    workspaceRequest: workspace.request,
    agents: createRoleStates(spec),
    activeTurn: null,
    parent: parentRef,
    waiting: null,
    groups: {},
    task: isObject(extra.task) ? extra.task : null,
    result: null,
    repair: null,
  };
  state.instances[id] = child;
  return child;
}

function childWorkspace(
  value: unknown,
  context: JsonObject,
  inherited: WorkflowWorkspace | null,
): { workspace: WorkflowWorkspace | null; request: JsonObject | null } {
  if (value === undefined || (isObject(value) && value.inherit === true)) {
    if (!inherited) throw new Error("parent workspace is not ready");
    return { workspace: inherited, request: null };
  }
  if (!isObject(value) || !isObject(value.createWorktree)) {
    throw new Error("call.workspace must contain createWorktree or inherit");
  }
  const create = renderValue(value.createWorktree, context);
  if (!isObject(create)) throw new Error("createWorktree must render to an object");
  return { workspace: null, request: { kind: "create", create } };
}

function fillMapSlots(
  state: WorkflowRunState,
  spec: JsonObject,
  parent: WorkflowInstance,
  groupName: string,
): void {
  if (state.stopRequested || state.pendingTerminal) return;
  const group = requireGroup(parent, groupName);
  const children = stringArray(group.children);
  let active = children.filter((id) => state.instances[id]?.status !== "returned").length;
  const items = arrayValue(group.items);
  const concurrency = numberValue(group.concurrency);
  let nextIndex = numberValue(group.nextIndex);
  while (active < concurrency && nextIndex < items.length) {
    const item = items[nextIndex];
    const task = { group: groupName, index: nextIndex, item };
    const child = spawnChild(
      state,
      spec,
      parent,
      objectValue(group.call),
      {
        kind: "map",
        instanceId: parent.id,
        state: parent.state,
        group: groupName,
        index: nextIndex,
        item,
      },
      { item, [stringValue(group.as)]: item, task },
    );
    children.push(child.id);
    nextIndex += 1;
    active += 1;
  }
  group.children = children;
  group.nextIndex = nextIndex;
}

function notifyParent(tx: Transaction, spec: JsonObject, child: WorkflowInstance): void {
  const parentRef = objectValue(child.parent);
  const parent = requireInstance(tx.state, stringValue(parentRef.instanceId));
  const definition = stateDefinition(
    flowDefinition(spec, parent.flow),
    stringValue(parentRef.state),
  );
  const result = childResult(child, parentRef);
  if (parentRef.kind === "call") {
    transition(tx, parent, definition, {
      event: "returned",
      message: "",
      data: result,
      acceptedAt: new Date().toISOString(),
      nativeTurnId: "scheduler",
    });
    return;
  }
  const groupName = stringValue(parentRef.group);
  const group = requireGroup(parent, groupName);
  const results = objectValue(group.results);
  results[String(numberValue(parentRef.index))] = result;
  group.results = results;
  fillMapSlots(tx.state, spec, parent, groupName);
  if (Object.keys(results).length === arrayValue(group.items).length) {
    finishMap(tx, spec, parent, definition, groupName);
  }
}

function finishMap(
  tx: Transaction,
  _spec: JsonObject,
  parent: WorkflowInstance,
  definition: JsonObject,
  groupName: string,
): void {
  const group = requireGroup(parent, groupName);
  const results = objectValue(group.results);
  const ordered = arrayValue(group.items).map((_, index) => results[String(index)]);
  queueEvent(tx, {
    type: "map_joined",
    instanceId: parent.id,
    flow: parent.flow,
    details: { group: groupName, size: ordered.length },
  });
  transition(tx, parent, definition, {
    event: "joined",
    message: "",
    data: { group: groupName, results: ordered },
    acceptedAt: new Date().toISOString(),
    nativeTurnId: "scheduler",
  });
}

function transition(
  tx: Transaction,
  instance: WorkflowInstance,
  definition: JsonObject,
  emission: WorkflowAcceptedEvent,
): void {
  const routes = isObject(definition.on) ? definition.on : {};
  const target = routes[emission.event];
  if (typeof target !== "string") {
    failState(tx, `unhandled_${emission.event.replaceAll(".", "_")}`);
    return;
  }
  const source = instance.state;
  instance.state = target;
  instance.status = "runnable";
  instance.waiting = null;
  instance.incoming = {
    event: emission.event,
    message: emission.message,
    data: emission.data,
  };
  queueEvent(tx, {
    type: "state_transition",
    instanceId: instance.id,
    flow: instance.flow,
    state: source,
    event: emission.event,
    details: { source, target },
  });
}

function requestTerminal(
  tx: Transaction,
  status: "complete" | "stopped" | "failed",
  reason: string,
): void {
  if (hasActiveTurns(tx.state)) {
    tx.state.stopRequested = true;
    tx.state.status = "stopping";
    tx.state.reason = reason;
    tx.state.pendingTerminal = { status, reason };
    return;
  }
  completeState(tx, status, reason);
}

function finalizeRequestedStop(tx: Transaction): void {
  if (!tx.state.stopRequested || hasActiveTurns(tx.state)) return;
  const pending = tx.state.pendingTerminal;
  if (pending) {
    completeState(tx, pending.status, pending.reason);
  } else {
    completeState(tx, "stopped", tx.state.reason ?? "requested");
  }
}

function completeState(
  tx: Transaction,
  status: "complete" | "stopped" | "failed",
  reason: string,
): void {
  tx.state.status = status;
  tx.state.reason = reason;
  tx.state.stopRequested = status !== "complete";
  tx.state.pendingTerminal = null;
  tx.state.completedAt = new Date().toISOString();
  queueEvent(tx, {
    type: terminalEventType(status),
    details: { reason },
  });
}

function terminalEventType(status: "complete" | "stopped" | "failed"): string {
  if (status === "complete") return "run_completed";
  if (status === "stopped") return "run_stopped";
  return "run_failed";
}

function failState(tx: Transaction, reason: string): void {
  completeState(tx, "failed", reason);
}

function buildContext(
  spec: JsonObject,
  state: WorkflowRunState,
  instance: WorkflowInstance,
  iteration = state.loop.iteration,
): JsonObject {
  const limits = isObject(spec.limits) ? spec.limits : {};
  const maxIterations = typeof limits.maxIterations === "number" ? limits.maxIterations : null;
  const maxRuntime = typeof limits.maxRuntime === "string" ? limits.maxRuntime : null;
  const runtimeSeconds = maxRuntime ? durationSeconds(maxRuntime) : null;
  const context: JsonObject = {
    inputs: instance.inputs,
    objective: instance.inputs.objective,
    event: instance.incoming,
    loop: { ...state.loop, iteration },
    budget: {
      turns_used: iteration,
      turn_budget: maxIterations ?? "unlimited",
      turns_remaining:
        maxIterations === null ? "unlimited" : Math.max(maxIterations - iteration, 0),
      time_used_seconds: state.loop.elapsedSeconds,
      time_budget: maxRuntime ?? "unlimited",
      time_budget_seconds: runtimeSeconds ?? "unlimited",
      time_remaining_seconds:
        runtimeSeconds === null
          ? "unlimited"
          : Math.max(runtimeSeconds - state.loop.elapsedSeconds, 0),
    },
    workspace: instance.workspace ?? {},
    agents: instance.agents,
    groups: instance.groups,
    instance: { id: instance.id, flow: instance.flow },
  };
  if (instance.task) {
    context.task = instance.task;
    context.item = instance.task.item;
  }
  return context;
}

function createPreviewState(spec: JsonObject): WorkflowRunState {
  return {
    schemaVersion: "paseo.workflows.run.v0.2",
    runId: "preview",
    workflow: { id: stringField(spec, "name"), name: stringField(spec, "name") },
    status: "queued",
    reason: null,
    stopRequested: false,
    pendingTerminal: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    startedAt: null,
    completedAt: null,
    loop: { iteration: 0, elapsedSeconds: 0 },
    eventSeq: 0,
    nextInstance: 1,
    instances: {},
    result: null,
  };
}

function routingPrompt(emits: JsonObject): string {
  const lines = [
    "",
    "Workflow routing:",
    "Before ending this turn, call `emit_event` exactly once with one allowed outcome:",
  ];
  for (const [event, rawDeclaration] of Object.entries(emits)) {
    const declaration = objectValue(rawDeclaration);
    lines.push(`- \`${event}\`: ${stringValue(declaration.description)}`);
    if (declaration.dataSchema !== undefined) {
      lines.push(`  dataSchema: ${JSON.stringify(declaration.dataSchema)}`);
    }
  }
  lines.push(
    "Use `message` for the complete handoff to the next agent and `data` for machine-readable fields.",
  );
  return `\n${lines.join("\n")}\n`;
}

function repairPrompt(reason: string, emits: JsonObject): string {
  return [
    `Your previous workflow turn could not be routed: ${reason}`,
    "Do not repeat the work. Call `emit_event` exactly once now.",
    routingPrompt(emits),
  ].join("\n");
}

function validateEventData(schema: unknown, data: unknown): void {
  if (schema === undefined) return;
  const validate = new Ajv2020Constructor({ allErrors: true, strict: true }).compile(schema);
  if (validate(data)) return;
  const errors = (validate.errors ?? [])
    .map((error) => `${error.instancePath || "(root)"} ${error.message ?? "is invalid"}`)
    .join("; ");
  throw new Error(`workflow event data is invalid: ${errors}`);
}

function queueEvent(tx: Transaction, event: Omit<WorkflowEventRecord, "seq" | "timestamp">): void {
  tx.state.eventSeq += 1;
  tx.events.push({
    seq: tx.state.eventSeq,
    timestamp: new Date().toISOString(),
    ...event,
  });
}

function parseState(value: JsonObject): WorkflowRunState {
  const parsed = WorkflowRunStateSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`invalid workflow state at ${issue.path.join(".")}: ${issue.message}`);
  }
  return parsed.data;
}

function requireInstance(state: WorkflowRunState, id: string): WorkflowInstance {
  const instance = state.instances[id];
  if (!instance) throw new Error(`workflow instance not found: ${id}`);
  return instance;
}

function requireRole(instance: WorkflowInstance, role: string): WorkflowRoleState {
  const state = instance.agents[role];
  if (!state) throw new Error(`workflow agent role not found: ${role}`);
  return state;
}

function requireActiveTurn(
  state: WorkflowRunState,
  instanceId: string,
  workflowTurnId: string,
): WorkflowActiveTurn {
  const turn = requireInstance(state, instanceId).activeTurn;
  if (!turn || turn.workflowTurnId !== workflowTurnId) {
    throw new Error(`workflow turn is no longer active: ${workflowTurnId}`);
  }
  return turn;
}

function findActiveTurnForAgent(
  state: WorkflowRunState,
  agentId: string,
): { instance: WorkflowInstance; turn: WorkflowActiveTurn } | null {
  for (const instance of Object.values(state.instances)) {
    if (instance.activeTurn?.agentId === agentId) {
      return { instance, turn: instance.activeTurn };
    }
  }
  return null;
}

function requireGroup(instance: WorkflowInstance, name: string): JsonObject {
  const group = instance.groups[name];
  if (!group) throw new Error(`workflow map group not found: ${name}`);
  return group;
}

function childResult(child: WorkflowInstance, parent: JsonObject): JsonObject {
  const result: JsonObject = {
    instanceId: child.id,
    flow: child.flow,
    output: child.result,
    workspace: child.workspace,
  };
  if (typeof parent.index === "number") result.index = parent.index;
  if ("item" in parent) result.item = parent.item;
  return result;
}

function flowDefinition(spec: JsonObject, name: string): JsonObject {
  return objectField(objectField(spec, "flows"), name);
}

function stateDefinition(flow: JsonObject, name: string): JsonObject {
  return objectField(objectField(flow, "states"), name);
}

function objectField(value: JsonObject, key: string): JsonObject {
  const item = value[key];
  if (!isObject(item)) throw new Error(`${key} must be an object`);
  return item;
}

function stringField(value: JsonObject, key: string): string {
  return stringValue(value[key]);
}

function objectValue(value: unknown): JsonObject {
  if (!isObject(value)) throw new Error("expected an object");
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a string");
  return value;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number") throw new Error("expected a number");
  return value;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("expected a string array");
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeName(value: string): string {
  return value.replaceAll("/", "-").replaceAll(/[^A-Za-z0-9_.-]/g, "-");
}

function hasActiveTurns(state: WorkflowRunState): boolean {
  return countActiveTurns(state) > 0;
}

function countActiveTurns(state: WorkflowRunState): number {
  return Object.values(state.instances).filter((instance) => instance.activeTurn).length;
}

function isTerminal(status: string): boolean {
  return ["stopped", "complete", "failed"].includes(status);
}

function turnKey(runId: string, turnId: string): string {
  return `${runId}:${turnId}`;
}

function createRunId(): string {
  return `wfr_${randomUUID().replaceAll("-", "")}`;
}

function durationSeconds(value: string): number {
  const amount = Number(value.slice(0, -1));
  return amount * ({ s: 1, m: 60, h: 3600, d: 86400 }[value.at(-1) ?? "s"] ?? 1);
}

function limitReason(state: WorkflowRunState, limits: JsonObject): string | null {
  if (
    typeof limits.maxRuntime === "string" &&
    state.loop.elapsedSeconds >= durationSeconds(limits.maxRuntime)
  ) {
    return "max_runtime";
  }
  return null;
}

function applyLimit(tx: Transaction, reason: string): void {
  tx.state.stopRequested = true;
  tx.state.reason = reason;
  tx.state.status = hasActiveTurns(tx.state) ? "stopping" : "stopped";
  tx.state.completedAt = tx.state.status === "stopped" ? new Date().toISOString() : null;
  queueEvent(tx, { type: "limit_reached", details: { reason } });
  if (tx.state.status === "stopped") {
    queueEvent(tx, { type: "run_stopped", details: { reason } });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
