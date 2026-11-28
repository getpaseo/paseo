import {
  createIntegrationRegistry,
  type ActiveAuthLease,
  type CompleteAgentStepInput,
  type GateResolutionInput,
  type IngestResult,
  type IntegrationConnections,
  type IntegrationContext,
  type IntegrationLogger,
  type IntegrationRegistry,
  type IntegrationStorage,
  type ListOpenGatesFilter,
  type ListRunsFilter,
  type NormalizedIntegrationEvent,
  type PublishOutputInput,
  type PublishOutputResult,
  type StartWorkflowInput,
  type StepAttemptRecord,
  type TickResult,
  type WorkflowEngine,
  type WorkflowEngineOptions,
  type WorkflowGateRecord,
  type WorkflowRunSnapshot,
} from "../index.js";
import {
  validateWorkflowIR,
  type AgentStepIR,
  type AuthGrantIR,
  type ExprNode,
  type GateStepIR,
  type IntegrationStepIR,
  type JsonObject,
  type JsonValue,
  type SleepStepIR,
  type StepIR,
  type WaitWorkflowStepIR,
  type WorkflowIR,
} from "../ir.js";
import {
  evaluateExpression,
  evaluateStringExpression,
  isJsonObject,
  type ExpressionContext,
  type StepEvalState,
} from "./expression.js";
import { validateAgainstSchema } from "./json-schema.js";
import { resolveTransition } from "./machine.js";

const NOOP_LOGGER: IntegrationLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const EMPTY_CONNECTIONS: IntegrationConnections = {
  async get() {
    return undefined;
  },
  async list() {
    return [];
  },
};

function createFallbackStorage(clock: () => Date): IntegrationStorage {
  const map = new Map<string, { value: JsonValue; expiresAt?: number }>();
  const locks = new Map<string, Promise<void>>();

  const isExpired = (entry: { expiresAt?: number }): boolean =>
    entry.expiresAt !== undefined && clock().getTime() >= entry.expiresAt;

  return {
    async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
      const entry = map.get(key);
      if (entry === undefined || isExpired(entry)) {
        map.delete(key);
        return undefined;
      }
      return structuredClone(entry.value) as T;
    },
    async set(key: string, value: JsonValue, options?: { readonly ttlMs?: number }): Promise<void> {
      const expiresAt =
        options?.ttlMs !== undefined ? clock().getTime() + options.ttlMs : undefined;
      map.set(key, { value: structuredClone(value), expiresAt });
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
    async list(prefix = "") {
      const out: { key: string; value: JsonValue }[] = [];
      for (const [key, entry] of map.entries()) {
        if (isExpired(entry)) {
          map.delete(key);
          continue;
        }
        if (key.startsWith(prefix)) {
          out.push({ key, value: structuredClone(entry.value) });
        }
      }
      return out;
    },
    async withLock<T>(key: string, _ttlMs: number, fn: () => Promise<T>): Promise<T> {
      const prev = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.set(
        key,
        prev.then(() => next),
      );
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

function createScopedStorage(
  base: IntegrationStorage,
  namespacePrefix: string,
): IntegrationStorage {
  const qualify = (key: string): string => `${namespacePrefix}${key}`;
  return {
    get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
      return base.get<T>(qualify(key));
    },
    set(key: string, value: JsonValue, options?: { readonly ttlMs?: number }): Promise<void> {
      return base.set(qualify(key), value, options);
    },
    delete(key: string): Promise<void> {
      return base.delete(qualify(key));
    },
    async list(prefix = "") {
      const fullPrefix = qualify(prefix);
      const entries = await base.list(fullPrefix);
      return entries.map((entry) => ({
        key: entry.key.slice(namespacePrefix.length),
        value: entry.value,
      }));
    },
    withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
      return base.withLock(qualify(key), ttlMs, fn);
    },
  };
}

export function createWorkflowEngineImpl(options: WorkflowEngineOptions): WorkflowEngine {
  const { store, runner, gates, clock } = options;
  const registry: IntegrationRegistry = Array.isArray(options.integrations)
    ? createIntegrationRegistry(options.integrations)
    : (options.integrations as IntegrationRegistry);
  const scopeId = options.scopeId ?? "default";
  const baseStorage = options.storage ?? createFallbackStorage(() => clock.now());
  const connections = options.connections ?? EMPTY_CONNECTIONS;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const log = options.log ?? NOOP_LOGGER;

  const workflows = new Map<string, WorkflowIR>();
  // Tracks runs currently executing inside advanceRun so synchronous nested publishOutput
  // calls do not re-enter advanceRun on the same run concurrently.
  const advancingRuns = new Set<string>();

  const registerWorkflow = (workflow: WorkflowIR): void => {
    const validated = validateWorkflowIR(JSON.parse(JSON.stringify(workflow)));
    workflows.set(validated.id, validated);
  };

  for (const wf of options.workflows ?? []) {
    registerWorkflow(wf);
  }

  const getWorkflowOrThrow = (workflowId: string): WorkflowIR => {
    const wf = workflows.get(workflowId);
    if (wf === undefined) {
      throw new Error(`workflow "${workflowId}" is not registered`);
    }
    return wf;
  };

  const makeIntegrationContext = (integrationId: string): IntegrationContext => ({
    scopeId,
    storage: createScopedStorage(baseStorage, `${scopeId}:${integrationId}:`),
    connections,
    ingest: async (event: NormalizedIntegrationEvent) => {
      await engine.ingest(event);
    },
    fetch: fetchFn,
    log,
    now: () => clock.now(),
  });

  const revokeLeases = async (
    attemptId: string | undefined,
    leases: readonly ActiveAuthLease[],
  ): Promise<void> => {
    const errors: unknown[] = [];
    for (const lease of leases) {
      const integration = registry.get(lease.integrationId);
      if (integration?.auth === undefined) {
        continue;
      }
      try {
        await integration.auth.revoke(lease.leaseId, makeIntegrationContext(lease.integrationId));
      } catch (error) {
        errors.push(error);
      }
    }
    if (attemptId !== undefined) {
      await store.setAttemptLeases(attemptId, []);
    }
    if (errors.length > 0) {
      log.warn("auth lease revocation encountered errors", { count: errors.length });
    }
  };

  const mintStepAuth = async (
    attemptId: string,
    authSpec: Readonly<Record<string, AuthGrantIR>> | undefined,
  ): Promise<{ readonly env: Record<string, string>; readonly leases: ActiveAuthLease[] }> => {
    if (authSpec === undefined) {
      return { env: {}, leases: [] };
    }
    const env: Record<string, string> = {};
    const minted: ActiveAuthLease[] = [];
    try {
      for (const [integrationId, grant] of Object.entries(authSpec)) {
        const integration = registry.get(integrationId);
        if (integration?.auth === undefined) {
          throw new Error(`integration "${integrationId}" does not provide an auth slot`);
        }
        const lease = await integration.auth.mint(grant, makeIntegrationContext(integrationId));
        minted.push({ integrationId, leaseId: lease.leaseId });
        Object.assign(env, lease.env);
      }
      if (minted.length > 0) {
        await store.setAttemptLeases(attemptId, minted);
      }
      return { env, leases: minted };
    } catch (error) {
      await revokeLeases(attemptId, minted);
      throw error;
    }
  };

  const buildExpressionContext = (
    workflow: WorkflowIR,
    run: WorkflowRunSnapshot,
    executionId: string | null,
  ): ExpressionContext => {
    const stepMap: Record<string, StepEvalState> = {};
    for (const attempt of run.attempts) {
      const prev = stepMap[attempt.stepId];
      const attemptsCount = Math.max(prev?.attempts ?? 0, attempt.attempt);
      if (attempt.status === "completed") {
        stepMap[attempt.stepId] = {
          outcome: attempt.outcome ?? null,
          outputs: attempt.output ?? null,
          attempts: attemptsCount,
        };
      } else if (prev === undefined) {
        stepMap[attempt.stepId] = {
          outcome: null,
          outputs: null,
          attempts: attemptsCount,
        };
      } else {
        stepMap[attempt.stepId] = {
          ...prev,
          attempts: attemptsCount,
        };
      }
    }

    return {
      event: run.event?.payload ?? null,
      prompt: run.event?.prompt ?? "",
      inputs: run.inputs,
      subject: {
        key: run.subjectKey ?? null,
        data: run.subjectData,
      },
      steps: stepMap,
      gate: run.lastGate ?? { choice: null, note: null, actor: null },
      values: workflow.values ?? {},
      executionId,
    };
  };

  const evaluateExprMap = (
    record: Readonly<Record<string, ExprNode>> | undefined,
    ctx: ExpressionContext,
  ): JsonObject => {
    const out: Record<string, JsonValue> = {};
    if (record === undefined) {
      return out;
    }
    for (const [key, node] of Object.entries(record)) {
      out[key] = evaluateExpression(node, ctx);
    }
    return out;
  };

  const evaluateStringMap = (
    record: Readonly<Record<string, ExprNode>> | undefined,
    ctx: ExpressionContext,
  ): Record<string, string> => {
    const out: Record<string, string> = {};
    if (record === undefined) {
      return out;
    }
    for (const [key, node] of Object.entries(record)) {
      out[key] = evaluateStringExpression(node, ctx);
    }
    return out;
  };

  const finalizeRunTerminal = async (
    workflow: WorkflowIR,
    runId: string,
    terminalStatus: "done" | "failed" | "cancelled",
    reason?: string,
    outputsExpr?: Readonly<Record<string, ExprNode>>,
  ): Promise<WorkflowRunSnapshot> => {
    const latest = await store.loadRun(runId);
    if (latest === undefined) {
      throw new Error(`run "${runId}" not found`);
    }
    const ctx = buildExpressionContext(workflow, latest, latest.id);
    const terminalOutputs =
      outputsExpr === undefined ? undefined : evaluateExprMap(outputsExpr, ctx);

    const terminalRun = await store.transitionRun({
      runId,
      status: terminalStatus,
      terminalReason: reason,
      terminalOutputs,
      now: clock.now(),
    });

    if (terminalStatus === "done" && workflow.publish !== undefined) {
      const pubCtx = buildExpressionContext(workflow, terminalRun, terminalRun.id);
      const outputKey = evaluateStringExpression(workflow.publish.key, pubCtx);
      const rawPayload =
        "kind" in workflow.publish.payload
          ? evaluateExpression(workflow.publish.payload as ExprNode, pubCtx)
          : evaluateExprMap(workflow.publish.payload, pubCtx);
      if (!isJsonObject(rawPayload)) {
        throw new Error(`workflow "${workflow.id}" publish.payload must evaluate to a JSON object`);
      }
      if (workflow.publish.schema !== undefined) {
        const validation = validateAgainstSchema(
          workflow.publish.schema,
          rawPayload,
          "publish.payload",
        );
        if (!validation.ok) {
          throw new Error(
            `workflow "${workflow.id}" publish.payload failed schema validation: ${validation.errors.join("; ")}`,
          );
        }
      }
      await engine.publishOutput({
        workflowId: workflow.id,
        outputKey,
        payload: rawPayload,
      });
    }

    if (terminalRun.subjectKey !== undefined) {
      const nextQueued = await store.dequeueNextRun(
        terminalRun.workflowId,
        terminalRun.subjectKey,
        clock.now(),
      );
      if (nextQueued !== undefined) {
        await advanceRun(nextQueued.id);
      }
    }

    return terminalRun;
  };

  const transitionAfterStepOutcome = async (
    workflow: WorkflowIR,
    runId: string,
    stepId: string,
    outcome: string,
  ): Promise<WorkflowRunSnapshot> => {
    const run = await store.loadRun(runId);
    if (run === undefined) {
      throw new Error(`run "${runId}" not found`);
    }
    if (
      run.status === "paused" ||
      run.status === "cancelled" ||
      run.status === "done" ||
      run.status === "failed"
    ) {
      return run;
    }

    const resolution = resolveTransition(workflow.states, stepId, outcome, run.loopCounts);
    if (resolution.kind === "unhandled") {
      return finalizeRunTerminal(
        workflow,
        runId,
        "failed",
        `unhandled outcome "${resolution.outcome}" on step "${stepId}"`,
      );
    }
    if (resolution.kind === "terminal") {
      return finalizeRunTerminal(
        workflow,
        runId,
        resolution.target.terminal,
        resolution.target.reason,
        resolution.target.outputs,
      );
    }

    return store.transitionRun({
      runId,
      status: "running",
      currentState: resolution.stateId,
      now: clock.now(),
    });
  };

  const executeAgentStep = async (
    workflow: WorkflowIR,
    run: WorkflowRunSnapshot,
    step: AgentStepIR,
    attempt: StepAttemptRecord,
  ): Promise<{ readonly done: boolean }> => {
    const ctx = buildExpressionContext(workflow, run, attempt.executionId);
    const prompt = evaluateStringExpression(step.prompt, ctx);
    const title = step.title === undefined ? undefined : evaluateStringExpression(step.title, ctx);
    const stepEnv = evaluateStringMap(step.env, ctx);

    let mintedLeases: ActiveAuthLease[] = [];
    try {
      const authResult = await mintStepAuth(attempt.id, step.auth);
      mintedLeases = authResult.leases;
      const mergedEnv = { ...stepEnv, ...authResult.env };

      const startResult = await runner.start({
        runId: run.id,
        workflowId: workflow.id,
        stepId: step.id,
        attempt: attempt.attempt,
        executionId: attempt.executionId,
        prompt,
        title,
        target: step.target,
        agent: step.agent,
        continuation: step.continuation,
        env: mergedEnv,
        outputSchema: step.outputSchema,
        tools: step.tools,
        allowOutputs: step.allowOutputs,
        maxRuntimeMs: step.maxRuntimeMs,
        idleTimeoutMs: step.idleTimeoutMs,
        startupTimeoutMs: step.startupTimeoutMs,
        autoArchive: step.autoArchive,
        background: step.background,
      });

      if (startResult.status === "running") {
        if (
          startResult.executionId !== undefined &&
          startResult.executionId !== attempt.executionId
        ) {
          await store.setAttemptExecutionId(attempt.id, startResult.executionId);
        }
        return { done: false };
      }

      // Synchronous completion or failure: ALWAYS revoke auth leases before transitioning.
      await revokeLeases(attempt.id, mintedLeases);
      mintedLeases = [];

      if (startResult.status === "failed") {
        await store.completeStepAttempt({
          runId: run.id,
          attemptId: attempt.id,
          status: "failed",
          error: startResult.error,
          now: clock.now(),
        });
        await finalizeRunTerminal(workflow, run.id, "failed", startResult.error);
        return { done: false };
      }

      const output = startResult.output;
      if (step.outputSchema !== undefined) {
        const validation = validateAgainstSchema(step.outputSchema, output ?? {}, "output");
        if (!validation.ok) {
          const message = `agent output validation failed: ${validation.errors.join("; ")}`;
          await store.completeStepAttempt({
            runId: run.id,
            attemptId: attempt.id,
            status: "failed",
            error: message,
            now: clock.now(),
          });
          await finalizeRunTerminal(workflow, run.id, "failed", message);
          return { done: false };
        }
      }

      const outcome =
        startResult.outcome ??
        (output !== undefined && typeof output["outcome"] === "string"
          ? (output["outcome"] as string)
          : "ok");

      await store.completeStepAttempt({
        runId: run.id,
        attemptId: attempt.id,
        status: "completed",
        outcome,
        output,
        now: clock.now(),
      });
      await transitionAfterStepOutcome(workflow, run.id, step.id, outcome);
      return { done: true };
    } catch (error) {
      await revokeLeases(attempt.id, mintedLeases);
      const message = error instanceof Error ? error.message : String(error);
      await store.completeStepAttempt({
        runId: run.id,
        attemptId: attempt.id,
        status: "failed",
        error: message,
        now: clock.now(),
      });
      await finalizeRunTerminal(workflow, run.id, "failed", message);
      return { done: false };
    }
  };

  const executeIntegrationStep = async (
    workflow: WorkflowIR,
    run: WorkflowRunSnapshot,
    step: IntegrationStepIR,
    attempt: StepAttemptRecord,
  ): Promise<{ readonly done: boolean }> => {
    const integration = registry.get(step.integration);
    const stepSpec = integration?.steps?.[step.step];
    if (stepSpec === undefined) {
      const message = `integration step "${step.integration}.${step.step}" is not registered`;
      await store.completeStepAttempt({
        runId: run.id,
        attemptId: attempt.id,
        status: "failed",
        error: message,
        now: clock.now(),
      });
      await finalizeRunTerminal(workflow, run.id, "failed", message);
      return { done: false };
    }

    const ctx = buildExpressionContext(workflow, run, attempt.executionId);
    const evaluatedInput = evaluateExprMap(step.input, ctx);

    const inputCheck = validateAgainstSchema(stepSpec.inputSchema, evaluatedInput, "input");
    if (!inputCheck.ok) {
      const message = `integration step "${step.integration}.${step.step}" input validation failed: ${inputCheck.errors.join("; ")}`;
      await store.completeStepAttempt({
        runId: run.id,
        attemptId: attempt.id,
        status: "failed",
        error: message,
        now: clock.now(),
      });
      await finalizeRunTerminal(workflow, run.id, "failed", message);
      return { done: false };
    }

    let mintedLeases: ActiveAuthLease[] = [];
    try {
      const authResult = await mintStepAuth(attempt.id, step.auth);
      mintedLeases = authResult.leases;

      const execResult = await stepSpec.execute(
        evaluatedInput,
        makeIntegrationContext(step.integration),
      );

      // Revoke leases immediately on BOTH completion AND suspension (waits hold zero leases).
      await revokeLeases(attempt.id, mintedLeases);
      mintedLeases = [];

      if (execResult.status === "suspended") {
        const timeoutMs = execResult.timeoutMs ?? step.timeoutMs;
        const wakeAt =
          timeoutMs !== undefined ? new Date(clock.now().getTime() + timeoutMs) : undefined;
        await store.suspendStepAttempt(attempt.id, {
          kind: "integration",
          integrationId: step.integration,
          stepName: step.step,
          waitKey: execResult.waitKey,
          input: evaluatedInput,
          wakeAt,
        });
        await store.transitionRun({
          runId: run.id,
          status: "waiting",
          currentState: step.id,
          now: clock.now(),
        });
        return { done: false };
      }

      if (stepSpec.outputSchema !== undefined && execResult.output !== undefined) {
        const outCheck = validateAgainstSchema(stepSpec.outputSchema, execResult.output, "output");
        if (!outCheck.ok) {
          const message = `integration step "${step.integration}.${step.step}" output validation failed: ${outCheck.errors.join("; ")}`;
          await store.completeStepAttempt({
            runId: run.id,
            attemptId: attempt.id,
            status: "failed",
            error: message,
            now: clock.now(),
          });
          await finalizeRunTerminal(workflow, run.id, "failed", message);
          return { done: false };
        }
      }

      await store.completeStepAttempt({
        runId: run.id,
        attemptId: attempt.id,
        status: "completed",
        outcome: execResult.outcome,
        output: execResult.output,
        now: clock.now(),
      });
      await transitionAfterStepOutcome(workflow, run.id, step.id, execResult.outcome);
      return { done: true };
    } catch (error) {
      await revokeLeases(attempt.id, mintedLeases);
      const message = error instanceof Error ? error.message : String(error);
      await store.completeStepAttempt({
        runId: run.id,
        attemptId: attempt.id,
        status: "failed",
        error: message,
        now: clock.now(),
      });
      await finalizeRunTerminal(workflow, run.id, "failed", message);
      return { done: false };
    }
  };

  const executeWaitWorkflowStep = async (
    workflow: WorkflowIR,
    run: WorkflowRunSnapshot,
    step: WaitWorkflowStepIR,
    attempt: StepAttemptRecord,
  ): Promise<{ readonly done: boolean }> => {
    const ctx = buildExpressionContext(workflow, run, attempt.executionId);
    const outputKey = evaluateStringExpression(step.outputKey, ctx);

    // 1. Race-free cache hit check before registering any wait.
    const existing = await store.findWorkflowOutput(step.workflow, outputKey);
    if (existing !== undefined) {
      const outcome = extractPublishedOutcome(existing.payload);
      await store.completeStepAttempt({
        runId: run.id,
        attemptId: attempt.id,
        status: "completed",
        outcome,
        output: existing.payload,
        now: clock.now(),
      });
      await transitionAfterStepOutcome(workflow, run.id, step.id, outcome);
      return { done: true };
    }

    // 2. Register suspended wait BEFORE dispatching child workflow so synchronous child
    //    publications atomically resolve this wait with zero race window.
    const wakeAt =
      step.timeoutMs !== undefined ? new Date(clock.now().getTime() + step.timeoutMs) : undefined;
    await store.suspendStepAttempt(attempt.id, {
      kind: "wait_workflow",
      workflowId: step.workflow,
      outputKey,
      wakeAt,
    });
    await store.transitionRun({
      runId: run.id,
      status: "waiting",
      currentState: step.id,
      now: clock.now(),
    });

    if (step.dispatchIfMissing === true) {
      const childInputs = evaluateExprMap(step.inputs, ctx);
      await engine.start({
        workflowId: step.workflow,
        inputs: childInputs,
      });
    }

    // Re-check whether the child workflow published synchronously while we were advancing.
    const reloaded = await store.loadRun(run.id);
    if (reloaded !== undefined && reloaded.status === "running") {
      return { done: true };
    }
    return { done: false };
  };

  const executeGateStep = async (
    workflow: WorkflowIR,
    run: WorkflowRunSnapshot,
    step: GateStepIR,
    attempt: StepAttemptRecord,
  ): Promise<{ readonly done: boolean }> => {
    const ctx = buildExpressionContext(workflow, run, attempt.executionId);
    const title = evaluateStringExpression(step.title, ctx);
    const summary =
      step.summary === undefined ? undefined : evaluateStringExpression(step.summary, ctx);
    const openedAt = clock.now();
    const expiresAt =
      step.timeoutMs !== undefined ? new Date(openedAt.getTime() + step.timeoutMs) : undefined;

    const gate = await store.openGate({
      runId: run.id,
      workflowId: workflow.id,
      stepId: step.id,
      attemptId: attempt.id,
      title,
      summary,
      recommended: step.recommended,
      choices: step.choices,
      openedAt,
      expiresAt,
    });

    await store.suspendStepAttempt(attempt.id, {
      kind: "gate",
      gateId: gate.id,
      wakeAt: expiresAt,
    });
    await store.transitionRun({
      runId: run.id,
      status: "waiting",
      currentState: step.id,
      now: openedAt,
    });
    await gates.onGateOpened(gate);
    return { done: false };
  };

  const executeSleepStep = async (
    workflow: WorkflowIR,
    run: WorkflowRunSnapshot,
    step: SleepStepIR,
    attempt: StepAttemptRecord,
  ): Promise<{ readonly done: boolean }> => {
    const now = clock.now();
    let wakeAt: Date;
    if (step.durationMs !== undefined) {
      wakeAt = new Date(now.getTime() + step.durationMs);
    } else if (step.until !== undefined) {
      const ctx = buildExpressionContext(workflow, run, attempt.executionId);
      const iso = evaluateStringExpression(step.until, ctx);
      const parsed = new Date(iso);
      if (Number.isNaN(parsed.getTime())) {
        const message = `invalid sleep.until timestamp: ${JSON.stringify(iso)}`;
        await store.completeStepAttempt({
          runId: run.id,
          attemptId: attempt.id,
          status: "failed",
          error: message,
          now,
        });
        await finalizeRunTerminal(workflow, run.id, "failed", message);
        return { done: false };
      }
      wakeAt = parsed;
    } else {
      wakeAt = now;
    }

    if (wakeAt.getTime() <= now.getTime()) {
      await store.completeStepAttempt({
        runId: run.id,
        attemptId: attempt.id,
        status: "completed",
        outcome: "done",
        now,
      });
      await transitionAfterStepOutcome(workflow, run.id, step.id, "done");
      return { done: true };
    }

    await store.suspendStepAttempt(attempt.id, {
      kind: "sleep",
      wakeAt,
    });
    await store.transitionRun({
      runId: run.id,
      status: "waiting",
      currentState: step.id,
      now,
    });
    return { done: false };
  };

  const dispatchStepExecution = (
    workflow: WorkflowIR,
    freshRun: WorkflowRunSnapshot,
    step: StepIR,
    attempt: StepAttemptRecord,
  ): Promise<{ readonly done: boolean }> => {
    switch (step.kind) {
      case "agent":
        return executeAgentStep(workflow, freshRun, step, attempt);
      case "integration":
        return executeIntegrationStep(workflow, freshRun, step, attempt);
      case "wait_workflow":
        return executeWaitWorkflowStep(workflow, freshRun, step, attempt);
      case "gate":
        return executeGateStep(workflow, freshRun, step, attempt);
      case "sleep":
        return executeSleepStep(workflow, freshRun, step, attempt);
    }
  };

  const advanceRun = async (runId: string): Promise<WorkflowRunSnapshot> => {
    if (advancingRuns.has(runId)) {
      const existing = await store.loadRun(runId);
      if (existing === undefined) {
        throw new Error(`run "${runId}" not found`);
      }
      return existing;
    }
    advancingRuns.add(runId);
    try {
      while (true) {
        const run = await store.loadRun(runId);
        if (run === undefined) {
          throw new Error(`run "${runId}" not found`);
        }
        if (run.status !== "running") {
          return run;
        }
        const workflow = getWorkflowOrThrow(run.workflowId);
        const step: StepIR | undefined = workflow.states[run.currentState];
        if (step === undefined) {
          return finalizeRunTerminal(
            workflow,
            run.id,
            "failed",
            `unknown state "${run.currentState}"`,
          );
        }

        const activeAttempt = run.attempts.find(
          (item) =>
            item.stepId === step.id && (item.status === "running" || item.status === "waiting"),
        );
        if (activeAttempt !== undefined) {
          return run;
        }

        if (
          step.when !== undefined &&
          !isTruthyJson(
            evaluateExpression(step.when, buildExpressionContext(workflow, run, run.id)),
          )
        ) {
          const skippedAttempt = await store.beginStepAttempt({
            runId: run.id,
            stepId: step.id,
            incrementLoop: false,
            now: clock.now(),
          });
          await store.completeStepAttempt({
            runId: run.id,
            attemptId: skippedAttempt.id,
            status: "skipped",
            outcome: "skipped",
            now: clock.now(),
          });
          await transitionAfterStepOutcome(workflow, run.id, step.id, "skipped");
          continue;
        }

        const executedCount = run.loopCounts[step.id] ?? 0;
        if (step.maxLoops !== undefined && executedCount >= step.maxLoops) {
          await transitionAfterStepOutcome(workflow, run.id, step.id, "max_loops_exceeded");
          continue;
        }

        const attempt = await store.beginStepAttempt({
          runId: run.id,
          stepId: step.id,
          incrementLoop: true,
          now: clock.now(),
        });

        const freshRun = (await store.loadRun(run.id)) ?? run;
        const result = await dispatchStepExecution(workflow, freshRun, step, attempt);

        if (!result.done) {
          const finalSnap = await store.loadRun(run.id);
          if (finalSnap === undefined) {
            throw new Error(`run "${run.id}" not found`);
          }
          return finalSnap;
        }
      }
    } finally {
      advancingRuns.delete(runId);
    }
  };

  const deliverEventToSuspendedRuns = async (
    event: NormalizedIntegrationEvent,
    onlyRunId?: string,
  ): Promise<WorkflowRunSnapshot[]> => {
    const resumed: WorkflowRunSnapshot[] = [];
    const waits = await store.listSuspendedWaits("integration", { includePaused: true });

    for (const entry of waits) {
      if (onlyRunId !== undefined && entry.runId !== onlyRunId) {
        continue;
      }
      if (entry.wait.kind !== "integration") {
        continue;
      }
      const run = await store.loadRun(entry.runId);
      if (run === undefined || (run.status !== "waiting" && run.status !== "paused")) {
        continue;
      }
      const integration = registry.get(entry.wait.integrationId);
      const stepSpec = integration?.steps?.[entry.wait.stepName];
      if (stepSpec?.onEvent === undefined) {
        continue;
      }

      const eventResult = await stepSpec.onEvent(
        event,
        entry.wait.input,
        makeIntegrationContext(entry.wait.integrationId),
      );
      if (eventResult.status === "still_waiting") {
        continue;
      }

      const workflow = getWorkflowOrThrow(run.workflowId);
      if (stepSpec.outputSchema !== undefined && eventResult.output !== undefined) {
        const outCheck = validateAgainstSchema(stepSpec.outputSchema, eventResult.output, "output");
        if (!outCheck.ok) {
          const message = `integration wait "${entry.wait.integrationId}.${entry.wait.stepName}" output validation failed: ${outCheck.errors.join("; ")}`;
          await store.completeStepAttempt({
            runId: run.id,
            attemptId: entry.attemptId,
            status: "failed",
            error: message,
            now: clock.now(),
          });
          if (run.status !== "paused") {
            resumed.push(await finalizeRunTerminal(workflow, run.id, "failed", message));
          }
          continue;
        }
      }

      await store.completeStepAttempt({
        runId: run.id,
        attemptId: entry.attemptId,
        status: "completed",
        outcome: eventResult.outcome,
        output: eventResult.output,
        now: clock.now(),
      });
      if (run.status === "paused") {
        // Record the completed wait without advancing until resume() is called.
        continue;
      }
      await transitionAfterStepOutcome(workflow, run.id, entry.stepId, eventResult.outcome);
      resumed.push(await advanceRun(run.id));
    }

    return resumed;
  };

  const resolveInputsWithDefaults = (
    workflow: WorkflowIR,
    provided?: Readonly<Record<string, JsonValue>>,
  ): Record<string, JsonValue> => {
    const resolved: Record<string, JsonValue> = { ...provided };
    if (workflow.inputs !== undefined) {
      for (const [name, spec] of Object.entries(workflow.inputs)) {
        if (resolved[name] === undefined && spec.default !== undefined) {
          resolved[name] = spec.default;
        }
      }
    }
    return resolved;
  };

  const cancelRunInternal = async (
    runId: string,
    reason = "cancelled",
  ): Promise<WorkflowRunSnapshot> => {
    const run = await store.loadRun(runId);
    if (run === undefined) {
      throw new Error(`run "${runId}" not found`);
    }
    if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
      return run;
    }

    for (const attempt of run.attempts) {
      if (attempt.status === "running") {
        try {
          await runner.cancel(attempt.executionId, reason);
        } catch (error) {
          log.warn("agent runner cancel failed", {
            executionId: attempt.executionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (attempt.activeLeases.length > 0) {
        await revokeLeases(attempt.id, attempt.activeLeases);
      }
      if (attempt.status === "running" || attempt.status === "waiting") {
        await store.completeStepAttempt({
          runId: run.id,
          attemptId: attempt.id,
          status: "cancelled",
          error: reason,
          now: clock.now(),
        });
      }
    }

    await store.cancelRunGates(run.id);
    const workflow = getWorkflowOrThrow(run.workflowId);
    return finalizeRunTerminal(workflow, run.id, "cancelled", reason);
  };

  const matchesWorkflowTrigger = (
    workflow: WorkflowIR,
    event: NormalizedIntegrationEvent,
  ): boolean => {
    if (!workflow.enabled) {
      return false;
    }
    const binding = workflow.on[event.type];
    if (binding === undefined) {
      return false;
    }
    if (binding.connection !== undefined && binding.connection !== event.connection) {
      return false;
    }
    if (binding.filters === undefined || Object.keys(binding.filters).length === 0) {
      return true;
    }

    const dotIdx = event.type.indexOf(".");
    if (dotIdx > 0) {
      const integrationId = event.type.slice(0, dotIdx);
      const integration = registry.get(integrationId);
      const triggerSpec = integration?.triggers?.[event.type];
      if (triggerSpec?.matchFilters !== undefined) {
        return triggerSpec.matchFilters(event, binding.filters);
      }
    }

    return matchGenericFilters(event, binding.filters);
  };

  const resolveStartSubjectKey = (
    workflow: WorkflowIR,
    input: StartWorkflowInput,
    inputs: Readonly<Record<string, JsonValue>>,
    subjectData: JsonObject,
  ): string | undefined => {
    const explicit = input.subjectKey ?? input.event?.subject?.key;
    if (explicit !== undefined || workflow.subject === undefined) {
      return explicit;
    }
    const subjectCtx: ExpressionContext = {
      event: input.event?.payload ?? null,
      prompt: input.event?.prompt ?? "",
      inputs,
      subject: { key: null, data: subjectData },
      steps: {},
      gate: { choice: null, note: null, actor: null },
      values: workflow.values ?? {},
      executionId: null,
    };
    return evaluateStringExpression(workflow.subject.key, subjectCtx);
  };

  const cleanupSupersededRun = async (cancelledRun: WorkflowRunSnapshot): Promise<void> => {
    for (const attempt of cancelledRun.attempts) {
      if (attempt.status === "running") {
        await runner.cancel(attempt.executionId, "superseded_by_new_run");
      }
      if (attempt.activeLeases.length > 0) {
        await revokeLeases(attempt.id, attempt.activeLeases);
      }
    }
    await store.cancelRunGates(cancelledRun.id);
  };

  const resumePendingWait = async (
    workflow: WorkflowIR,
    run: WorkflowRunSnapshot,
  ): Promise<WorkflowRunSnapshot | undefined> => {
    const lastAttempt = run.attempts[run.attempts.length - 1];
    if (lastAttempt === undefined || lastAttempt.stepId !== run.currentState) {
      return undefined;
    }
    if (lastAttempt.status === "failed") {
      return finalizeRunTerminal(
        workflow,
        run.id,
        "failed",
        lastAttempt.error ?? `step "${lastAttempt.stepId}" failed while paused`,
      );
    }
    if (lastAttempt.status === "completed") {
      await store.transitionRun({
        runId: run.id,
        status: "running",
        now: clock.now(),
      });
      await transitionAfterStepOutcome(
        workflow,
        run.id,
        lastAttempt.stepId,
        lastAttempt.outcome ?? "ok",
      );
      return advanceRun(run.id);
    }
    if (lastAttempt.status === "waiting" && lastAttempt.wait?.kind === "wait_workflow") {
      const published = await store.findWorkflowOutput(
        lastAttempt.wait.workflowId,
        lastAttempt.wait.outputKey,
      );
      if (published !== undefined) {
        const outcome = extractPublishedOutcome(published.payload);
        await store.completeStepAttempt({
          runId: run.id,
          attemptId: lastAttempt.id,
          status: "completed",
          outcome,
          output: published.payload,
          now: clock.now(),
        });
        await store.transitionRun({
          runId: run.id,
          status: "running",
          now: clock.now(),
        });
        await transitionAfterStepOutcome(workflow, run.id, lastAttempt.stepId, outcome);
        return advanceRun(run.id);
      }
    }
    return undefined;
  };

  const startInternal = async (
    input: StartWorkflowInput,
    startOptions: { readonly skipSignalDelivery?: boolean } = {},
  ): Promise<WorkflowRunSnapshot> => {
    const workflow = getWorkflowOrThrow(input.workflowId);
    const inputs = resolveInputsWithDefaults(workflow, input.inputs);
    const subjectData = input.subjectData ?? input.event?.subject?.data ?? {};
    const subjectKey = resolveStartSubjectKey(workflow, input, inputs, subjectData);

    const accepted = await store.acceptRun({
      workflowId: workflow.id,
      initialState: workflow.initial,
      subjectKey,
      subjectData,
      onConflict: workflow.subject?.onConflict,
      inputs,
      event: input.event,
      now: clock.now(),
    });

    if (accepted.action === "ignored") {
      return accepted.existingRun;
    }
    if (accepted.action === "signal") {
      if (!startOptions.skipSignalDelivery && input.event !== undefined) {
        const resumed = await deliverEventToSuspendedRuns(input.event, accepted.existingRun.id);
        return resumed[0] ?? accepted.existingRun;
      }
      return (await store.loadRun(accepted.existingRun.id)) ?? accepted.existingRun;
    }
    if (accepted.action === "queued") {
      return accepted.run;
    }
    if (accepted.action === "replaced") {
      await cleanupSupersededRun(accepted.cancelledRun);
    }

    return advanceRun(accepted.run.id);
  };

  const engine: WorkflowEngine = {
    registerWorkflow,

    async start(input: StartWorkflowInput): Promise<WorkflowRunSnapshot> {
      return startInternal(input);
    },

    async ingest(event: NormalizedIntegrationEvent): Promise<IngestResult> {
      const resumedRuns = await deliverEventToSuspendedRuns(event);
      const matchedRuns: WorkflowRunSnapshot[] = [];

      for (const workflow of workflows.values()) {
        if (!matchesWorkflowTrigger(workflow, event)) {
          continue;
        }
        // `deliverEventToSuspendedRuns` already delivered this event to every matching
        // suspended wait, so `onConflict: "signal"` must not deliver it a second time.
        const run = await startInternal(
          {
            workflowId: workflow.id,
            event,
          },
          { skipSignalDelivery: true },
        );
        matchedRuns.push(run);
      }

      return { matchedRuns, resumedRuns };
    },

    async completeAgentStep(input: CompleteAgentStepInput): Promise<WorkflowRunSnapshot> {
      const run = await store.loadRun(input.runId);
      if (run === undefined) {
        throw new Error(`run "${input.runId}" not found`);
      }
      const attempt = run.attempts.find(
        (item) => item.executionId === input.executionId && item.status === "running",
      );
      if (attempt === undefined) {
        throw new Error(
          `no running agent step attempt with executionId "${input.executionId}" on run "${input.runId}"`,
        );
      }

      const workflow = getWorkflowOrThrow(run.workflowId);
      const step = workflow.states[attempt.stepId];
      if (step === undefined || step.kind !== "agent") {
        throw new Error(`state "${attempt.stepId}" is not an agent step`);
      }

      // ALWAYS revoke minted leases regardless of success, failure, or schema error.
      await revokeLeases(attempt.id, attempt.activeLeases);

      if (input.error !== undefined) {
        await store.completeStepAttempt({
          runId: run.id,
          attemptId: attempt.id,
          status: "failed",
          error: input.error,
          now: clock.now(),
        });
        return finalizeRunTerminal(workflow, run.id, "failed", input.error);
      }

      if (step.outputSchema !== undefined) {
        const validation = validateAgainstSchema(step.outputSchema, input.output ?? {}, "output");
        if (!validation.ok) {
          const message = `agent output validation failed: ${validation.errors.join("; ")}`;
          await store.completeStepAttempt({
            runId: run.id,
            attemptId: attempt.id,
            status: "failed",
            error: message,
            now: clock.now(),
          });
          return finalizeRunTerminal(workflow, run.id, "failed", message);
        }
      }

      const outcome =
        input.outcome ??
        (input.output !== undefined && typeof input.output["outcome"] === "string"
          ? (input.output["outcome"] as string)
          : "ok");

      await store.completeStepAttempt({
        runId: run.id,
        attemptId: attempt.id,
        status: "completed",
        outcome,
        output: input.output,
        now: clock.now(),
      });
      await transitionAfterStepOutcome(workflow, run.id, step.id, outcome);
      return advanceRun(run.id);
    },

    async resolveGate(
      gateId: string,
      resolution: GateResolutionInput,
    ): Promise<WorkflowRunSnapshot> {
      const gate = await store.getGate(gateId);
      if (gate === undefined) {
        throw new Error(`gate "${gateId}" not found`);
      }
      if (gate.status !== "open") {
        throw new Error(`gate "${gateId}" is already ${gate.status}`);
      }
      const validChoice = gate.choices.some((choice) => choice.id === resolution.choice);
      if (!validChoice) {
        throw new Error(
          `invalid gate choice "${resolution.choice}" for gate "${gateId}" (allowed: ${gate.choices.map((c) => c.id).join(", ")})`,
        );
      }

      const now = clock.now();
      const resolved = await store.resolveGate(gateId, {
        choice: resolution.choice,
        note: resolution.note,
        actor: resolution.actor,
        resolvedAt: now,
      });
      if (resolved === undefined) {
        throw new Error(`gate "${gateId}" could not be resolved`);
      }

      await gates.onGateResolved?.(resolved);

      const runBeforeResolve = await store.loadRun(resolved.runId);
      const isPaused = runBeforeResolve?.status === "paused";

      const gateState = {
        choice: resolution.choice,
        note: resolution.note ?? null,
        actor: resolution.actor ?? null,
      };
      await store.completeStepAttempt({
        runId: resolved.runId,
        attemptId: resolved.attemptId,
        status: "completed",
        outcome: resolution.choice,
        output: gateState,
        now,
      });

      if (isPaused) {
        // Persist gate decision while honoring the pause; resume() will transition and advance.
        return store.transitionRun({
          runId: resolved.runId,
          status: "paused",
          pausedFromStatus: runBeforeResolve.pausedFromStatus ?? "waiting",
          currentState: resolved.stepId,
          lastGate: gateState,
          now,
        });
      }

      await store.transitionRun({
        runId: resolved.runId,
        status: "running",
        currentState: resolved.stepId,
        lastGate: gateState,
        now,
      });

      const workflow = getWorkflowOrThrow(resolved.workflowId);
      await transitionAfterStepOutcome(
        workflow,
        resolved.runId,
        resolved.stepId,
        resolution.choice,
      );
      return advanceRun(resolved.runId);
    },

    async publishOutput(input: PublishOutputInput): Promise<PublishOutputResult> {
      const record = {
        workflowId: input.workflowId,
        outputKey: input.outputKey,
        payload: structuredClone(input.payload),
        publishedAt: clock.now(),
      };
      const matchedWaits = await store.publishWorkflowOutput(record);
      const resumedRuns: WorkflowRunSnapshot[] = [];

      for (const waitEntry of matchedWaits) {
        const run = await store.loadRun(waitEntry.runId);
        if (run === undefined || run.status !== "waiting") {
          continue;
        }
        const workflow = getWorkflowOrThrow(run.workflowId);
        const outcome = extractPublishedOutcome(record.payload);
        await store.completeStepAttempt({
          runId: run.id,
          attemptId: waitEntry.attemptId,
          status: "completed",
          outcome,
          output: record.payload,
          now: clock.now(),
        });
        await transitionAfterStepOutcome(workflow, run.id, waitEntry.stepId, outcome);
        if (!advancingRuns.has(run.id)) {
          resumedRuns.push(await advanceRun(run.id));
        } else {
          const updated = await store.loadRun(run.id);
          if (updated !== undefined) {
            resumedRuns.push(updated);
          }
        }
      }

      return { output: record, resumedRuns };
    },

    async pause(runId: string): Promise<WorkflowRunSnapshot> {
      const run = await store.loadRun(runId);
      if (run === undefined) {
        throw new Error(`run "${runId}" not found`);
      }
      if (run.status === "paused") {
        return run;
      }
      if (run.status !== "running" && run.status !== "waiting") {
        throw new Error(`cannot pause run "${runId}" in status "${run.status}"`);
      }

      // Cancel any in-flight agent execution and revoke its leases so paused runs hold zero tokens.
      for (const attempt of run.attempts) {
        if (attempt.status === "running") {
          await runner.cancel(attempt.executionId, "paused");
          await revokeLeases(attempt.id, attempt.activeLeases);
          await store.completeStepAttempt({
            runId: run.id,
            attemptId: attempt.id,
            status: "cancelled",
            error: "paused",
            now: clock.now(),
          });
        }
      }

      return store.transitionRun({
        runId: run.id,
        status: "paused",
        pausedFromStatus: run.status,
        now: clock.now(),
      });
    },

    async resume(runId: string): Promise<WorkflowRunSnapshot> {
      const run = await store.loadRun(runId);
      if (run === undefined) {
        throw new Error(`run "${runId}" not found`);
      }
      if (run.status !== "paused") {
        throw new Error(`cannot resume run "${runId}" in status "${run.status}"`);
      }

      const workflow = getWorkflowOrThrow(run.workflowId);
      const restoreStatus = run.pausedFromStatus ?? "running";

      if (restoreStatus === "waiting") {
        const resumedFromWait = await resumePendingWait(workflow, run);
        if (resumedFromWait !== undefined) {
          return resumedFromWait;
        }
      }

      const restored = await store.transitionRun({
        runId: run.id,
        status: restoreStatus,
        now: clock.now(),
      });

      if (restoreStatus === "running") {
        return advanceRun(restored.id);
      }

      // Re-evaluate any due timers or timeouts that expired while paused.
      await engine.tick();
      return (await store.loadRun(runId)) ?? restored;
    },

    async cancel(runId: string, reason?: string): Promise<WorkflowRunSnapshot> {
      return cancelRunInternal(runId, reason);
    },

    async tick(): Promise<TickResult> {
      const now = clock.now();
      const expired = await store.findExpiredWaits(now);
      const wokenRuns: WorkflowRunSnapshot[] = [];

      for (const entry of expired) {
        const run = await store.loadRun(entry.runId);
        if (run === undefined || run.status !== "waiting") {
          continue;
        }
        const workflow = getWorkflowOrThrow(run.workflowId);
        if (entry.wait.kind === "sleep") {
          await store.completeStepAttempt({
            runId: run.id,
            attemptId: entry.attemptId,
            status: "completed",
            outcome: "done",
            now,
          });
          await transitionAfterStepOutcome(workflow, run.id, entry.stepId, "done");
          wokenRuns.push(await advanceRun(run.id));
          continue;
        }

        if (entry.wait.kind === "gate") {
          const expiredGate = await store.expireGate(entry.wait.gateId);
          if (expiredGate !== undefined) {
            await gates.onGateExpired?.(expiredGate);
          }
        }

        await store.completeStepAttempt({
          runId: run.id,
          attemptId: entry.attemptId,
          status: "completed",
          outcome: "timeout",
          now,
        });
        await transitionAfterStepOutcome(workflow, run.id, entry.stepId, "timeout");
        wokenRuns.push(await advanceRun(run.id));
      }

      return { wokenRuns };
    },

    getRun(runId: string): Promise<WorkflowRunSnapshot | undefined> {
      return store.loadRun(runId);
    },

    listRuns(filter?: ListRunsFilter): Promise<readonly WorkflowRunSnapshot[]> {
      return store.listRuns(filter);
    },

    listOpenGates(filter?: ListOpenGatesFilter): Promise<readonly WorkflowGateRecord[]> {
      return store.listOpenGates(filter);
    },
  };

  return engine;
}

function extractPublishedOutcome(payload: JsonObject): string {
  if (typeof payload["verdict"] === "string") {
    return payload["verdict"];
  }
  if (typeof payload["outcome"] === "string") {
    return payload["outcome"];
  }
  return "done";
}

function isTruthyJson(value: JsonValue): boolean {
  return value !== false && value !== null && value !== 0 && value !== "";
}

function matchPayloadField(actual: JsonValue | undefined, expected: JsonValue): boolean {
  if (Array.isArray(expected)) {
    if (Array.isArray(actual)) {
      return expected.some((item) => actual.includes(item));
    }
    return expected.includes(actual as JsonValue);
  }
  if (Array.isArray(actual)) {
    return actual.includes(expected);
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function matchSingleFilter(
  event: NormalizedIntegrationEvent,
  key: string,
  expected: JsonValue,
): boolean {
  if (key === "from_users" && Array.isArray(expected)) {
    const actorLogin = event.actor?.login;
    const actorId = event.actor?.id;
    return expected.some((item) => item === actorLogin || item === actorId);
  }
  if (key === "contains" && typeof expected === "string") {
    return extractEventText(event).includes(expected);
  }
  if (key === "exclude_contains" && typeof expected === "string") {
    return !extractEventText(event).includes(expected);
  }
  if (key === "pattern" && typeof expected === "string") {
    return new RegExp(expected, "u").test(extractEventText(event));
  }
  return matchPayloadField(event.payload[key], expected);
}

function matchGenericFilters(event: NormalizedIntegrationEvent, filters: JsonObject): boolean {
  for (const [key, expected] of Object.entries(filters)) {
    if (!matchSingleFilter(event, key, expected)) {
      return false;
    }
  }
  return true;
}

function extractEventText(event: NormalizedIntegrationEvent): string {
  if (typeof event.prompt === "string" && event.prompt.length > 0) {
    return event.prompt;
  }
  if (typeof event.payload["body"] === "string") {
    return event.payload["body"];
  }
  if (typeof event.payload["text"] === "string") {
    return event.payload["text"];
  }
  return "";
}
