import type { z } from "zod";
import { createWorkflowEngineImpl } from "./internal/engine.js";
import type {
  AgentSpecIR,
  AgentTargetIR,
  AllowOutputIR,
  AuthGrantIR,
  GateChoiceIR,
  JsonObject,
  JsonSchema,
  JsonValue,
  TerminalStatus,
  WorkflowIR,
} from "./ir.js";

export type {
  AgentSpecIR,
  AgentTargetIR,
  AllowOutputIR,
  AuthGrantIR,
  GateChoiceIR,
  JsonObject,
  JsonSchema,
  JsonValue,
  TerminalStatus,
  WorkflowIR,
};
export { validateWorkflowIR, WorkflowValidationError } from "./ir.js";

export interface Clock {
  now(): Date;
}

export interface EventActor {
  readonly id: string;
  readonly login?: string;
  readonly isBot: boolean;
  readonly isSelfApp: boolean;
}

export interface NormalizedIntegrationEvent {
  readonly id: string;
  readonly type: string;
  readonly connection?: string;
  readonly actor?: EventActor;
  readonly subject?: {
    readonly key?: string;
    readonly data?: JsonObject;
  };
  readonly payload: JsonObject;
  readonly prompt?: string;
  readonly occurredAt: Date;
}

export interface IntegrationStorageEntry {
  readonly key: string;
  readonly value: JsonValue;
}

/**
 * Narrow scoped key-value/document storage provided to integrations.
 * Backed by one generic table or store in the host runtime — never a raw database handle.
 */
export interface IntegrationStorage {
  get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: JsonValue, options?: { readonly ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<readonly IntegrationStorageEntry[]>;
  withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
}

export interface IntegrationConnectionRecord {
  readonly id: string;
  readonly name: string;
  readonly integration: string;
  readonly config?: JsonObject;
  readonly secret?: JsonObject;
}

export interface IntegrationConnections {
  get(connectionNameOrId: string): Promise<IntegrationConnectionRecord | undefined>;
  list(): Promise<readonly IntegrationConnectionRecord[]>;
}

export interface IntegrationLogger {
  debug(message: string, meta?: JsonObject): void;
  info(message: string, meta?: JsonObject): void;
  warn(message: string, meta?: JsonObject): void;
  error(message: string, meta?: JsonObject): void;
}

/**
 * The ONLY host context passed into integration hooks (`triggers`, `steps`, `auth`, `tools`).
 * Deliberately excludes database handles, SQL clients, and workflow engine internals.
 */
export interface IntegrationContext {
  readonly scopeId: string;
  readonly storage: IntegrationStorage;
  readonly connections: IntegrationConnections;
  readonly ingest: (event: NormalizedIntegrationEvent) => Promise<void>;
  readonly fetch: typeof globalThis.fetch;
  readonly log: IntegrationLogger;
  readonly now: () => Date;
}

export interface IntegrationTriggerSpec {
  readonly event: string;
  readonly filterSchema?: z.ZodType;
  readonly normalize?: (
    raw: JsonObject,
    ctx: IntegrationContext,
  ) => Promise<NormalizedIntegrationEvent> | NormalizedIntegrationEvent;
  readonly matchFilters?: (event: NormalizedIntegrationEvent, filters: JsonObject) => boolean;
}

export type IntegrationStepExecuteResult =
  | { readonly status: "completed"; readonly outcome: string; readonly output?: JsonObject }
  | { readonly status: "suspended"; readonly waitKey: string; readonly timeoutMs?: number };

export type IntegrationStepEventResult =
  | { readonly status: "completed"; readonly outcome: string; readonly output?: JsonObject }
  | { readonly status: "still_waiting" };

/** Uniform contract covering both synchronous actions and suspended event waits. */
export interface IntegrationStepSpec {
  readonly inputSchema: JsonSchema | z.ZodType;
  readonly outputSchema?: JsonSchema | z.ZodType;
  readonly outcomes: readonly string[];
  execute(input: JsonObject, ctx: IntegrationContext): Promise<IntegrationStepExecuteResult>;
  onEvent?(
    event: NormalizedIntegrationEvent,
    input: JsonObject,
    ctx: IntegrationContext,
  ): Promise<IntegrationStepEventResult>;
}

export interface IntegrationAuthLease {
  readonly leaseId: string;
  readonly env: Readonly<Record<string, string>>;
  readonly expiresAt?: Date;
}

export interface IntegrationAuthSlot {
  mint(scope: AuthGrantIR, ctx: IntegrationContext): Promise<IntegrationAuthLease>;
  revoke(leaseId: string, ctx: IntegrationContext): Promise<void>;
}

export interface IntegrationToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface IntegrationToolsSlot {
  readonly grantSchema: z.ZodType<JsonValue>;
  readonly tools: readonly IntegrationToolDefinition[];
  execute(
    tool: string,
    args: JsonObject,
    grant: JsonValue,
    ctx: IntegrationContext,
  ): Promise<JsonValue>;
}

/** 4-slot opt-in integration contract (triggers, steps, auth, tools). */
export interface WorkflowIntegration {
  readonly id: string;
  readonly triggers?: Readonly<Record<string, IntegrationTriggerSpec>>;
  readonly steps?: Readonly<Record<string, IntegrationStepSpec>>;
  readonly auth?: IntegrationAuthSlot;
  readonly tools?: IntegrationToolsSlot;
}

export interface IntegrationRegistry {
  get(id: string): WorkflowIntegration | undefined;
  list(): readonly WorkflowIntegration[];
}

export function createIntegrationRegistry(
  integrations: readonly WorkflowIntegration[],
): IntegrationRegistry {
  const byId = new Map<string, WorkflowIntegration>();
  for (const integration of integrations) {
    if (byId.has(integration.id)) {
      throw new Error(`duplicate workflow integration id "${integration.id}"`);
    }
    byId.set(integration.id, integration);
  }
  return {
    get(id: string): WorkflowIntegration | undefined {
      return byId.get(id);
    },
    list(): readonly WorkflowIntegration[] {
      return [...byId.values()];
    },
  };
}

export interface ActiveAuthLease {
  readonly integrationId: string;
  readonly leaseId: string;
}

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export type StepAttemptStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type StepWaitSpec =
  | {
      readonly kind: "integration";
      readonly integrationId: string;
      readonly stepName: string;
      readonly waitKey: string;
      readonly input: JsonObject;
      readonly wakeAt?: Date;
    }
  | {
      readonly kind: "wait_workflow";
      readonly workflowId: string;
      readonly outputKey: string;
      readonly wakeAt?: Date;
    }
  | {
      readonly kind: "gate";
      readonly gateId: string;
      readonly wakeAt?: Date;
    }
  | {
      readonly kind: "sleep";
      readonly wakeAt: Date;
    };

export interface StepAttemptRecord {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly executionId: string;
  readonly status: StepAttemptStatus;
  readonly outcome?: string;
  readonly output?: JsonObject;
  readonly error?: string;
  readonly wait?: StepWaitSpec;
  readonly activeLeases: readonly ActiveAuthLease[];
  readonly startedAt: Date;
  readonly finishedAt?: Date;
}

export interface WorkflowGateRecord {
  readonly id: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly title: string;
  readonly summary?: string;
  readonly recommended?: string;
  readonly choices: readonly GateChoiceIR[];
  readonly status: "open" | "resolved" | "expired" | "cancelled";
  readonly openedAt: Date;
  readonly expiresAt?: Date;
  readonly resolution?: GateResolution;
}

export interface GateResolution {
  readonly choice: string;
  readonly note?: string;
  readonly actor?: string;
  readonly resolvedAt: Date;
}

export interface GateResolutionInput {
  readonly choice: string;
  readonly note?: string;
  readonly actor?: string;
}

export interface PublishedWorkflowOutput {
  readonly workflowId: string;
  readonly outputKey: string;
  readonly payload: JsonObject;
  readonly publishedAt: Date;
}

export interface SuspendedWaitRecord {
  readonly runId: string;
  readonly attemptId: string;
  readonly stepId: string;
  readonly wait: StepWaitSpec;
}

export interface WorkflowRunSnapshot {
  readonly id: string;
  readonly workflowId: string;
  readonly status: WorkflowRunStatus;
  readonly pausedFromStatus?: "running" | "waiting";
  readonly subjectKey?: string;
  readonly subjectData: JsonObject;
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly event?: NormalizedIntegrationEvent;
  readonly currentState: string;
  readonly loopCounts: Readonly<Record<string, number>>;
  readonly attempts: readonly StepAttemptRecord[];
  readonly lastGate?: {
    readonly choice: string;
    readonly note: string | null;
    readonly actor: string | null;
  };
  readonly terminalReason?: string;
  readonly terminalOutputs?: JsonObject;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt?: Date;
}

export interface AcceptWorkflowRunInput {
  readonly workflowId: string;
  readonly initialState: string;
  readonly subjectKey?: string;
  readonly subjectData: JsonObject;
  readonly onConflict?: "signal" | "queue" | "ignore" | "cancel_previous";
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly event?: NormalizedIntegrationEvent;
  readonly now: Date;
}

export type AcceptWorkflowRunResult =
  | { readonly action: "started"; readonly run: WorkflowRunSnapshot }
  | { readonly action: "queued"; readonly run: WorkflowRunSnapshot }
  | { readonly action: "ignored"; readonly existingRun: WorkflowRunSnapshot }
  | { readonly action: "signal"; readonly existingRun: WorkflowRunSnapshot }
  | {
      readonly action: "replaced";
      readonly run: WorkflowRunSnapshot;
      readonly cancelledRun: WorkflowRunSnapshot;
    };

export interface BeginStepAttemptInput {
  readonly runId: string;
  readonly stepId: string;
  readonly incrementLoop: boolean;
  readonly now: Date;
}

export interface CompleteStepAttemptInput {
  readonly runId: string;
  readonly attemptId: string;
  readonly status: "completed" | "failed" | "cancelled" | "skipped";
  readonly outcome?: string;
  readonly output?: JsonObject;
  readonly error?: string;
  readonly now: Date;
}

export interface TransitionRunInput {
  readonly runId: string;
  readonly status: WorkflowRunStatus;
  readonly currentState?: string;
  readonly pausedFromStatus?: "running" | "waiting";
  readonly lastGate?: WorkflowRunSnapshot["lastGate"];
  readonly terminalReason?: string;
  readonly terminalOutputs?: JsonObject;
  readonly now: Date;
}

export interface OpenGateInput {
  readonly runId: string;
  readonly workflowId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly title: string;
  readonly summary?: string;
  readonly recommended?: string;
  readonly choices: readonly GateChoiceIR[];
  readonly openedAt: Date;
  readonly expiresAt?: Date;
}

export interface ListRunsFilter {
  readonly workflowId?: string;
  readonly subjectKey?: string;
  readonly status?: WorkflowRunStatus | readonly WorkflowRunStatus[];
}

export interface ListOpenGatesFilter {
  readonly workflowId?: string;
  readonly runId?: string;
}

/** Persistence seam implemented by host storage backends (remote, embedded, or in-memory). */
export interface WorkflowStore {
  acceptRun(input: AcceptWorkflowRunInput): Promise<AcceptWorkflowRunResult>;
  loadRun(runId: string): Promise<WorkflowRunSnapshot | undefined>;
  listRuns(filter?: ListRunsFilter): Promise<readonly WorkflowRunSnapshot[]>;
  dequeueNextRun(
    workflowId: string,
    subjectKey: string,
    now: Date,
  ): Promise<WorkflowRunSnapshot | undefined>;

  beginStepAttempt(input: BeginStepAttemptInput): Promise<StepAttemptRecord>;
  setAttemptLeases(attemptId: string, leases: readonly ActiveAuthLease[]): Promise<void>;
  setAttemptExecutionId(attemptId: string, executionId: string): Promise<void>;
  suspendStepAttempt(attemptId: string, wait: StepWaitSpec): Promise<void>;
  completeStepAttempt(input: CompleteStepAttemptInput): Promise<WorkflowRunSnapshot>;
  transitionRun(input: TransitionRunInput): Promise<WorkflowRunSnapshot>;

  listSuspendedWaits(kind?: StepWaitSpec["kind"]): Promise<readonly SuspendedWaitRecord[]>;
  findExpiredWaits(now: Date): Promise<readonly SuspendedWaitRecord[]>;

  publishWorkflowOutput(input: PublishedWorkflowOutput): Promise<readonly SuspendedWaitRecord[]>;
  findWorkflowOutput(
    workflowId: string,
    outputKey: string,
  ): Promise<PublishedWorkflowOutput | undefined>;

  openGate(input: OpenGateInput): Promise<WorkflowGateRecord>;
  getGate(gateId: string): Promise<WorkflowGateRecord | undefined>;
  listOpenGates(filter?: ListOpenGatesFilter): Promise<readonly WorkflowGateRecord[]>;
  resolveGate(gateId: string, resolution: GateResolution): Promise<WorkflowGateRecord | undefined>;
  expireGate(gateId: string): Promise<WorkflowGateRecord | undefined>;
  cancelRunGates(runId: string): Promise<readonly WorkflowGateRecord[]>;
}

export interface AgentStepRequest {
  readonly runId: string;
  readonly workflowId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly executionId: string;
  readonly prompt: string;
  readonly title?: string;
  readonly target?: AgentTargetIR;
  readonly agent?: AgentSpecIR;
  readonly continuation?: { readonly mode: string };
  readonly env: Readonly<Record<string, string>>;
  readonly outputSchema?: JsonSchema;
  readonly tools?: Readonly<Record<string, JsonValue>>;
  readonly allowOutputs?: Readonly<Record<string, AllowOutputIR>>;
  readonly maxRuntimeMs?: number;
  readonly idleTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly autoArchive?: boolean;
  readonly background?: boolean;
}

export type AgentStepStartResult =
  | { readonly status: "completed"; readonly outcome?: string; readonly output?: JsonObject }
  | { readonly status: "running"; readonly executionId?: string }
  | { readonly status: "failed"; readonly error: string };

export interface AgentRunner {
  start(request: AgentStepRequest): Promise<AgentStepStartResult>;
  cancel(executionId: string, reason: string): Promise<void>;
  inspect?(executionId: string): Promise<AgentStepStartResult>;
}

export interface GateSink {
  onGateOpened(gate: WorkflowGateRecord): Promise<void>;
  onGateResolved?(gate: WorkflowGateRecord): Promise<void>;
  onGateExpired?(gate: WorkflowGateRecord): Promise<void>;
}

export interface StartWorkflowInput {
  readonly workflowId: string;
  readonly inputs?: Readonly<Record<string, JsonValue>>;
  readonly event?: NormalizedIntegrationEvent;
  readonly subjectKey?: string;
  readonly subjectData?: JsonObject;
}

export interface CompleteAgentStepInput {
  readonly runId: string;
  readonly executionId: string;
  readonly outcome?: string;
  readonly output?: JsonObject;
  readonly error?: string;
}

export interface PublishOutputInput {
  readonly workflowId: string;
  readonly outputKey: string;
  readonly payload: JsonObject;
}

export interface PublishOutputResult {
  readonly output: PublishedWorkflowOutput;
  readonly resumedRuns: readonly WorkflowRunSnapshot[];
}

export interface IngestResult {
  readonly matchedRuns: readonly WorkflowRunSnapshot[];
  readonly resumedRuns: readonly WorkflowRunSnapshot[];
}

export interface TickResult {
  readonly wokenRuns: readonly WorkflowRunSnapshot[];
}

export interface WorkflowEngineOptions {
  readonly store: WorkflowStore;
  readonly runner: AgentRunner;
  readonly gates: GateSink;
  readonly integrations: IntegrationRegistry | readonly WorkflowIntegration[];
  readonly clock: Clock;
  readonly workflows?: readonly WorkflowIR[];
  readonly scopeId?: string;
  readonly storage?: IntegrationStorage;
  readonly connections?: IntegrationConnections;
  readonly fetch?: typeof globalThis.fetch;
  readonly log?: IntegrationLogger;
}

/** Opaque durable execution engine interface (storage- and runtime-agnostic). */
export interface WorkflowEngine {
  registerWorkflow(workflow: WorkflowIR): void;
  ingest(event: NormalizedIntegrationEvent): Promise<IngestResult>;
  start(input: StartWorkflowInput): Promise<WorkflowRunSnapshot>;
  completeAgentStep(input: CompleteAgentStepInput): Promise<WorkflowRunSnapshot>;
  resolveGate(gateId: string, resolution: GateResolutionInput): Promise<WorkflowRunSnapshot>;
  publishOutput(input: PublishOutputInput): Promise<PublishOutputResult>;
  pause(runId: string): Promise<WorkflowRunSnapshot>;
  resume(runId: string): Promise<WorkflowRunSnapshot>;
  cancel(runId: string, reason?: string): Promise<WorkflowRunSnapshot>;
  tick(): Promise<TickResult>;
  getRun(runId: string): Promise<WorkflowRunSnapshot | undefined>;
  listRuns(filter?: ListRunsFilter): Promise<readonly WorkflowRunSnapshot[]>;
  listOpenGates(filter?: ListOpenGatesFilter): Promise<readonly WorkflowGateRecord[]>;
}

export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
  return createWorkflowEngineImpl(options);
}
