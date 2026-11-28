import { z } from "zod";
import { parseDurationMs, type DurationInput } from "./internal/duration.js";
import {
  buildTemplateExpr,
  isJsonObject,
  isJsonValue,
  parseExprPath,
  parseExpression,
  parseTemplateExpression,
  type ExprNode,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
} from "./internal/expression.js";
import { isZodSchema, normalizeJsonSchema, zodToJsonSchema } from "./internal/json-schema.js";
import {
  validateWorkflowIR,
  type AgentSpecIR,
  type AgentStepIR,
  type AgentTargetIR,
  type AllowOutputIR,
  type AuthGrantIR,
  type ContinuationIR,
  type GateChoiceIR,
  type GateStepIR,
  type InputSpecIR,
  type IntegrationStepIR,
  type SleepStepIR,
  type StepIR,
  type SubjectConflictPolicy,
  type TerminalStatus,
  type TransitionTargetIR,
  type TriggerBindingIR,
  type WaitWorkflowStepIR,
  type WorkflowIR,
  type WorktreeTargetIR,
} from "./ir.js";

export type ExprInput = ExprNode | JsonValue;
export type StringExprInput = ExprNode | string;

export type TransitionTargetInput =
  | string
  | StepHandle
  | TransitionTargetIR
  | {
      readonly terminal: "succeeded";
      readonly reason?: string;
      readonly outputs?: Readonly<Record<string, ExprInput>>;
    };

export interface StepHandle<TId extends string = string> {
  readonly __kind: "step_handle";
  readonly id: TId;
  readonly blueprint: StepBlueprint;
  out(path: string): ExprNode;
  outcome(): ExprNode;
  attempts(): ExprNode;
}

export interface StepBlueprint {
  readonly __kind: "step_blueprint";
  compile(id: string, extraTransitions?: Readonly<Record<string, TransitionTargetInput>>): StepIR;
}

/** Reference a runtime path in pure IR data (zero closures). */
export function ref(path: string): ExprNode {
  return { kind: "path", path: parseExprPath(path) };
}

/** Tagged template literal that compiles to a canonical JSON `ExprNode`. */
export function tpl(
  strings: TemplateStringsArray,
  ...values: readonly (ExprNode | string | number | boolean)[]
): ExprNode {
  const parts: (string | ExprNode)[] = [];
  for (let i = 0; i < strings.length; i += 1) {
    const literalPart = strings[i]!;
    if (literalPart.length > 0) {
      parts.push(literalPart);
    }
    if (i < values.length) {
      const interpolated = values[i]!;
      if (isExprNode(interpolated)) {
        parts.push(interpolated);
      } else {
        parts.push(String(interpolated));
      }
    }
  }
  return buildTemplateExpr(parts);
}

/** Pure data expression constructors (compile directly to JSON `ExprNode`s). */
export const expr = {
  literal(value: JsonValue): ExprNode {
    return { kind: "literal", value };
  },
  ref(path: string): ExprNode {
    return ref(path);
  },
  event(subpath?: string): ExprNode {
    const segments =
      subpath === undefined || subpath.trim() === ""
        ? []
        : subpath
            .trim()
            .split(".")
            .filter((segment) => segment.length > 0);
    return { kind: "path", path: { namespace: "event", path: segments } };
  },
  input(name: string): ExprNode {
    return { kind: "path", path: { namespace: "inputs", name } };
  },
  subjectKey(): ExprNode {
    return { kind: "path", path: { namespace: "subject", field: "key" } };
  },
  subjectData(subpath: string): ExprNode {
    const segments = subpath
      .trim()
      .split(".")
      .filter((segment) => segment.length > 0);
    return { kind: "path", path: { namespace: "subject", field: "data", path: segments } };
  },
  stepOutcome(stepId: string): ExprNode {
    return { kind: "path", path: { namespace: "steps", stepId, field: "outcome" } };
  },
  stepAttempts(stepId: string): ExprNode {
    return { kind: "path", path: { namespace: "steps", stepId, field: "attempts" } };
  },
  stepOutput(stepId: string, subpath: string): ExprNode {
    const segments = subpath
      .trim()
      .split(".")
      .filter((segment) => segment.length > 0);
    return {
      kind: "path",
      path: { namespace: "steps", stepId, field: "outputs", path: segments },
    };
  },
  gate(field: "choice" | "note" | "actor"): ExprNode {
    return { kind: "path", path: { namespace: "gate", field } };
  },
  executionId(): ExprNode {
    return { kind: "path", path: { namespace: "execution", field: "id" } };
  },
  prompt(): ExprNode {
    return { kind: "path", path: { namespace: "paseo", field: "prompt" } };
  },
  value(name: string): ExprNode {
    return { kind: "path", path: { namespace: "values", name } };
  },
  not(value: ExprInput): ExprNode {
    return { kind: "not", value: toExprNode(value) };
  },
  eq(left: ExprInput, right: ExprInput): ExprNode {
    return { kind: "binary", operator: "==", left: toExprNode(left), right: toExprNode(right) };
  },
  neq(left: ExprInput, right: ExprInput): ExprNode {
    return { kind: "binary", operator: "!=", left: toExprNode(left), right: toExprNode(right) };
  },
  and(left: ExprInput, right: ExprInput): ExprNode {
    return { kind: "binary", operator: "&&", left: toExprNode(left), right: toExprNode(right) };
  },
  or(left: ExprInput, right: ExprInput): ExprNode {
    return { kind: "binary", operator: "||", left: toExprNode(left), right: toExprNode(right) };
  },
  coalesce(first: ExprInput, second: ExprInput, ...rest: readonly ExprInput[]): ExprNode {
    let acc: ExprNode = {
      kind: "binary",
      operator: "??",
      left: toExprNode(first),
      right: toExprNode(second),
    };
    for (const next of rest) {
      acc = { kind: "binary", operator: "??", left: acc, right: toExprNode(next) };
    }
    return acc;
  },
} as const;

export interface TerminalOptions {
  readonly reason?: string;
  readonly outputs?: Readonly<Record<string, ExprInput>>;
}

function makeTerminal(
  status: TerminalStatus,
  reasonOrOptions?: string | TerminalOptions,
): TransitionTargetIR {
  const options: TerminalOptions =
    typeof reasonOrOptions === "string" ? { reason: reasonOrOptions } : (reasonOrOptions ?? {});
  const target: {
    terminal: TerminalStatus;
    reason?: string;
    outputs?: Readonly<Record<string, ExprNode>>;
  } = { terminal: status };
  if (options.reason !== undefined) {
    target.reason = options.reason;
  }
  if (options.outputs !== undefined) {
    target.outputs = compileExprRecord(options.outputs);
  }
  return target;
}

export const terminal = {
  done(reasonOrOptions?: string | TerminalOptions): TransitionTargetIR {
    return makeTerminal("done", reasonOrOptions);
  },
  succeeded(reasonOrOptions?: string | TerminalOptions): TransitionTargetIR {
    return makeTerminal("done", reasonOrOptions);
  },
  failed(reasonOrOptions?: string | TerminalOptions): TransitionTargetIR {
    return makeTerminal("failed", reasonOrOptions);
  },
  cancelled(reasonOrOptions?: string | TerminalOptions): TransitionTargetIR {
    return makeTerminal("cancelled", reasonOrOptions);
  },
} as const;

export type WorktreeTargetInput =
  | { readonly mode: "branch-off"; readonly newBranch: StringExprInput; readonly base?: string }
  | { readonly mode: "checkout-branch"; readonly branch: StringExprInput }
  | { readonly mode: "checkout-pr"; readonly prNumber: ExprInput };

export interface AgentTargetInput {
  readonly daemon?: string;
  readonly cwd?: string;
  readonly environment?: string;
  readonly worktree?: WorktreeTargetInput;
}

export interface AgentStepConfig {
  readonly when?: ExprNode | string;
  readonly maxLoops?: number;
  readonly target?: AgentTargetInput;
  readonly agent?: AgentSpecIR;
  readonly continuation?: ContinuationIR;
  readonly title?: StringExprInput;
  readonly prompt: StringExprInput;
  readonly maxRuntime?: DurationInput;
  readonly idleTimeout?: DurationInput;
  readonly startupTimeout?: DurationInput;
  readonly autoArchive?: boolean;
  readonly background?: boolean;
  readonly env?: Readonly<Record<string, StringExprInput>>;
  readonly auth?: Readonly<Record<string, AuthGrantIR>>;
  readonly tools?: Readonly<Record<string, JsonValue>>;
  readonly output?: z.ZodType | JsonSchema;
  readonly outputs?: Readonly<Record<string, AllowOutputIR>>;
  readonly allowOutputs?: Readonly<Record<string, AllowOutputIR>>;
  readonly on?: Readonly<Record<string, TransitionTargetInput>>;
}

export interface IntegrationStepConfig {
  readonly when?: ExprNode | string;
  readonly maxLoops?: number;
  readonly input?: Readonly<Record<string, ExprInput>>;
  readonly auth?: Readonly<Record<string, AuthGrantIR>>;
  readonly timeout?: DurationInput;
  readonly on?: Readonly<Record<string, TransitionTargetInput>>;
}

export interface WaitWorkflowStepConfig {
  readonly when?: ExprNode | string;
  readonly maxLoops?: number;
  readonly workflow?: string | WorkflowIR;
  readonly outputKey?: StringExprInput;
  readonly correlationKey?: StringExprInput;
  readonly dispatchIfMissing?: boolean;
  readonly inputs?: Readonly<Record<string, ExprInput>>;
  readonly timeout?: DurationInput;
  readonly on?: Readonly<Record<string, TransitionTargetInput>>;
}

export interface GateStepConfig {
  readonly when?: ExprNode | string;
  readonly maxLoops?: number;
  readonly title: StringExprInput;
  readonly summary?: StringExprInput;
  readonly recommended?: string;
  readonly choices: readonly GateChoiceIR[];
  readonly timeout?: DurationInput;
  readonly onTimeout?: TransitionTargetInput;
  readonly on?: Readonly<Record<string, TransitionTargetInput>>;
}

export interface SleepStepConfig {
  readonly when?: ExprNode | string;
  readonly maxLoops?: number;
  readonly duration?: DurationInput;
  readonly until?: StringExprInput;
  readonly on?: Readonly<Record<string, TransitionTargetInput>>;
}

function createHandle<TId extends string>(id: TId, blueprint: StepBlueprint): StepHandle<TId> {
  return {
    __kind: "step_handle",
    id,
    blueprint,
    out(path: string): ExprNode {
      return expr.stepOutput(id, path);
    },
    outcome(): ExprNode {
      return expr.stepOutcome(id);
    },
    attempts(): ExprNode {
      return expr.stepAttempts(id);
    },
  };
}

function buildAgentBlueprint(config: AgentStepConfig): StepBlueprint {
  return {
    __kind: "step_blueprint",
    compile(id, extraTransitions): AgentStepIR {
      const compiled: {
        id: string;
        kind: "agent";
        when?: ExprNode;
        maxLoops?: number;
        target?: AgentTargetIR;
        agent?: AgentSpecIR;
        continuation?: ContinuationIR;
        title?: ExprNode;
        prompt: ExprNode;
        maxRuntimeMs?: number;
        idleTimeoutMs?: number;
        startupTimeoutMs?: number;
        autoArchive?: boolean;
        background?: boolean;
        env?: Readonly<Record<string, ExprNode>>;
        auth?: Readonly<Record<string, AuthGrantIR>>;
        tools?: Readonly<Record<string, JsonValue>>;
        outputSchema?: JsonSchema;
        allowOutputs?: Readonly<Record<string, AllowOutputIR>>;
        on: Readonly<Record<string, TransitionTargetIR>>;
      } = {
        id,
        kind: "agent",
        prompt: toStringExprNode(config.prompt),
        on: compileTransitions(config.on, extraTransitions),
      };

      if (config.when !== undefined) {
        compiled.when = toConditionExpr(config.when);
      }
      if (config.maxLoops !== undefined) {
        compiled.maxLoops = config.maxLoops;
      }
      if (config.target !== undefined) {
        compiled.target = compileAgentTarget(config.target);
      }
      if (config.agent !== undefined) {
        compiled.agent = compileAgentSpec(config.agent);
      }
      if (config.continuation !== undefined) {
        compiled.continuation = { mode: config.continuation.mode };
      }
      if (config.title !== undefined) {
        compiled.title = toStringExprNode(config.title);
      }
      if (config.maxRuntime !== undefined) {
        compiled.maxRuntimeMs = parseDurationMs(config.maxRuntime, `${id}.maxRuntime`);
      }
      if (config.idleTimeout !== undefined) {
        compiled.idleTimeoutMs = parseDurationMs(config.idleTimeout, `${id}.idleTimeout`);
      }
      if (config.startupTimeout !== undefined) {
        compiled.startupTimeoutMs = parseDurationMs(config.startupTimeout, `${id}.startupTimeout`);
      }
      if (config.autoArchive !== undefined) {
        compiled.autoArchive = config.autoArchive;
      }
      if (config.background !== undefined) {
        compiled.background = config.background;
      }
      if (config.env !== undefined) {
        compiled.env = compileStringExprRecord(config.env);
      }
      if (config.auth !== undefined && Object.keys(config.auth).length > 0) {
        compiled.auth = cloneJsonObjectMap(config.auth);
      }
      if (config.tools !== undefined) {
        compiled.tools = structuredClone(config.tools);
      }
      if (config.output !== undefined) {
        compiled.outputSchema = compileSchemaInput(config.output);
      }
      const allowOutputs = config.allowOutputs ?? config.outputs;
      if (allowOutputs !== undefined) {
        compiled.allowOutputs = compileAllowOutputs(allowOutputs);
      }
      return canonicalizeStep(compiled) as AgentStepIR;
    },
  };
}

function buildIntegrationBlueprint(
  qualifiedName: string,
  config: IntegrationStepConfig,
): StepBlueprint {
  const dotIndex = qualifiedName.indexOf(".");
  if (dotIndex <= 0 || dotIndex === qualifiedName.length - 1) {
    throw new Error(
      `integration step name must have format "<integration>.<step>" (got ${JSON.stringify(qualifiedName)})`,
    );
  }
  const integration = qualifiedName.slice(0, dotIndex);
  const stepName = qualifiedName.slice(dotIndex + 1);

  return {
    __kind: "step_blueprint",
    compile(id, extraTransitions): IntegrationStepIR {
      const compiled: {
        id: string;
        kind: "integration";
        when?: ExprNode;
        maxLoops?: number;
        integration: string;
        step: string;
        input: Readonly<Record<string, ExprNode>>;
        auth?: Readonly<Record<string, AuthGrantIR>>;
        timeoutMs?: number;
        on: Readonly<Record<string, TransitionTargetIR>>;
      } = {
        id,
        kind: "integration",
        integration,
        step: stepName,
        input: compileExprRecord(config.input ?? {}),
        on: compileTransitions(config.on, extraTransitions),
      };
      if (config.when !== undefined) {
        compiled.when = toConditionExpr(config.when);
      }
      if (config.maxLoops !== undefined) {
        compiled.maxLoops = config.maxLoops;
      }
      if (config.auth !== undefined && Object.keys(config.auth).length > 0) {
        compiled.auth = cloneJsonObjectMap(config.auth);
      }
      if (config.timeout !== undefined) {
        compiled.timeoutMs = parseDurationMs(config.timeout, `${id}.timeout`);
      }
      return canonicalizeStep(compiled) as IntegrationStepIR;
    },
  };
}

function buildWaitWorkflowBlueprint(
  workflowRef: string | WorkflowIR | undefined,
  config: WaitWorkflowStepConfig,
): StepBlueprint {
  const resolvedWorkflow = workflowRef ?? config.workflow;
  if (resolvedWorkflow === undefined) {
    throw new Error("waitWorkflow step requires a target workflow id or WorkflowIR");
  }
  const workflowId = typeof resolvedWorkflow === "string" ? resolvedWorkflow : resolvedWorkflow.id;
  const rawKey = config.outputKey ?? config.correlationKey;
  if (rawKey === undefined) {
    throw new Error("waitWorkflow step requires outputKey (or correlationKey)");
  }

  return {
    __kind: "step_blueprint",
    compile(id, extraTransitions): WaitWorkflowStepIR {
      const compiled: {
        id: string;
        kind: "wait_workflow";
        when?: ExprNode;
        maxLoops?: number;
        workflow: string;
        outputKey: ExprNode;
        dispatchIfMissing?: boolean;
        inputs?: Readonly<Record<string, ExprNode>>;
        timeoutMs?: number;
        on: Readonly<Record<string, TransitionTargetIR>>;
      } = {
        id,
        kind: "wait_workflow",
        workflow: workflowId,
        outputKey: toStringExprNode(rawKey),
        on: compileTransitions(config.on, extraTransitions),
      };
      if (config.when !== undefined) {
        compiled.when = toConditionExpr(config.when);
      }
      if (config.maxLoops !== undefined) {
        compiled.maxLoops = config.maxLoops;
      }
      if (config.dispatchIfMissing !== undefined) {
        compiled.dispatchIfMissing = config.dispatchIfMissing;
      }
      if (config.inputs !== undefined) {
        compiled.inputs = compileExprRecord(config.inputs);
      }
      if (config.timeout !== undefined) {
        compiled.timeoutMs = parseDurationMs(config.timeout, `${id}.timeout`);
      }
      return canonicalizeStep(compiled) as WaitWorkflowStepIR;
    },
  };
}

function buildGateBlueprint(config: GateStepConfig): StepBlueprint {
  return {
    __kind: "step_blueprint",
    compile(id, extraTransitions): GateStepIR {
      const mergedOn: Record<string, TransitionTargetInput> = {
        ...config.on,
      };
      if (config.onTimeout !== undefined && mergedOn["timeout"] === undefined) {
        mergedOn["timeout"] = config.onTimeout;
      }
      const compiled: {
        id: string;
        kind: "gate";
        when?: ExprNode;
        maxLoops?: number;
        title: ExprNode;
        summary?: ExprNode;
        recommended?: string;
        choices: readonly GateChoiceIR[];
        timeoutMs?: number;
        on: Readonly<Record<string, TransitionTargetIR>>;
      } = {
        id,
        kind: "gate",
        title: toStringExprNode(config.title),
        choices: config.choices.map((choice) => {
          const item: { id: string; label: string; description?: string } = {
            id: choice.id,
            label: choice.label,
          };
          if (choice.description !== undefined) {
            item.description = choice.description;
          }
          return item;
        }),
        on: compileTransitions(mergedOn, extraTransitions),
      };
      if (config.when !== undefined) {
        compiled.when = toConditionExpr(config.when);
      }
      if (config.maxLoops !== undefined) {
        compiled.maxLoops = config.maxLoops;
      }
      if (config.summary !== undefined) {
        compiled.summary = toStringExprNode(config.summary);
      }
      if (config.recommended !== undefined) {
        compiled.recommended = config.recommended;
      }
      if (config.timeout !== undefined) {
        compiled.timeoutMs = parseDurationMs(config.timeout, `${id}.timeout`);
      }
      return canonicalizeStep(compiled) as GateStepIR;
    },
  };
}

function buildSleepBlueprint(config: SleepStepConfig): StepBlueprint {
  return {
    __kind: "step_blueprint",
    compile(id, extraTransitions): SleepStepIR {
      const compiled: {
        id: string;
        kind: "sleep";
        when?: ExprNode;
        maxLoops?: number;
        durationMs?: number;
        until?: ExprNode;
        on: Readonly<Record<string, TransitionTargetIR>>;
      } = {
        id,
        kind: "sleep",
        on: compileTransitions(config.on, extraTransitions),
      };
      if (config.when !== undefined) {
        compiled.when = toConditionExpr(config.when);
      }
      if (config.maxLoops !== undefined) {
        compiled.maxLoops = config.maxLoops;
      }
      if (config.duration !== undefined) {
        compiled.durationMs = parseDurationMs(config.duration, `${id}.duration`);
      }
      if (config.until !== undefined) {
        compiled.until = toStringExprNode(config.until);
      }
      return canonicalizeStep(compiled) as SleepStepIR;
    },
  };
}

function agentStep(config: AgentStepConfig): StepBlueprint;
function agentStep<TId extends string>(id: TId, config: AgentStepConfig): StepHandle<TId>;
function agentStep(
  idOrConfig: string | AgentStepConfig,
  maybeConfig?: AgentStepConfig,
): StepBlueprint | StepHandle {
  if (typeof idOrConfig === "string") {
    if (maybeConfig === undefined) {
      throw new Error("step.agent(id, config) requires a config object");
    }
    return createHandle(idOrConfig, buildAgentBlueprint(maybeConfig));
  }
  return buildAgentBlueprint(idOrConfig);
}

function integrationStep(qualifiedName: string, config?: IntegrationStepConfig): StepBlueprint;
function integrationStep<TId extends string>(
  id: TId,
  qualifiedName: string,
  config?: IntegrationStepConfig,
): StepHandle<TId>;
function integrationStep(
  first: string,
  second?: string | IntegrationStepConfig,
  third?: IntegrationStepConfig,
): StepBlueprint | StepHandle {
  if (typeof second === "string") {
    return createHandle(first, buildIntegrationBlueprint(second, third ?? {}));
  }
  return buildIntegrationBlueprint(first, second ?? {});
}

function waitWorkflowStep(config: WaitWorkflowStepConfig): StepBlueprint;
function waitWorkflowStep<TId extends string>(
  id: TId,
  workflow: string | WorkflowIR,
  config: WaitWorkflowStepConfig,
): StepHandle<TId>;
function waitWorkflowStep(
  first: string | WaitWorkflowStepConfig,
  second?: string | WorkflowIR,
  third?: WaitWorkflowStepConfig,
): StepBlueprint | StepHandle {
  if (typeof first === "string") {
    if (second === undefined || third === undefined) {
      throw new Error("step.waitWorkflow(id, workflow, config) requires workflow and config");
    }
    return createHandle(first, buildWaitWorkflowBlueprint(second, third));
  }
  return buildWaitWorkflowBlueprint(undefined, first);
}

function gateStep(config: GateStepConfig): StepBlueprint;
function gateStep<TId extends string>(id: TId, config: GateStepConfig): StepHandle<TId>;
function gateStep(
  idOrConfig: string | GateStepConfig,
  maybeConfig?: GateStepConfig,
): StepBlueprint | StepHandle {
  if (typeof idOrConfig === "string") {
    if (maybeConfig === undefined) {
      throw new Error("step.gate(id, config) requires a config object");
    }
    return createHandle(idOrConfig, buildGateBlueprint(maybeConfig));
  }
  return buildGateBlueprint(idOrConfig);
}

function sleepStep(config: SleepStepConfig): StepBlueprint;
function sleepStep<TId extends string>(id: TId, config: SleepStepConfig): StepHandle<TId>;
function sleepStep(
  idOrConfig: string | SleepStepConfig,
  maybeConfig?: SleepStepConfig,
): StepBlueprint | StepHandle {
  if (typeof idOrConfig === "string") {
    if (maybeConfig === undefined) {
      throw new Error("step.sleep(id, config) requires a config object");
    }
    return createHandle(idOrConfig, buildSleepBlueprint(maybeConfig));
  }
  return buildSleepBlueprint(idOrConfig);
}

export const step = {
  agent: agentStep,
  integration: integrationStep,
  waitWorkflow: waitWorkflowStep,
  gate: gateStep,
  sleep: sleepStep,
} as const;

export interface DefineWorkflowInput {
  readonly id?: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly on: Readonly<Record<string, TriggerBindingIR>>;
  readonly intake?: JsonObject;
  readonly inputs?: Readonly<Record<string, InputSpecIR>>;
  readonly values?: Readonly<Record<string, ExprInput>>;
  readonly subject?: {
    readonly key: StringExprInput;
    readonly onConflict?: SubjectConflictPolicy;
  };
  readonly maxRuntime?: DurationInput;
  readonly initial: string | StepHandle;
  readonly steps?: Readonly<Record<string, StepBlueprint | StepHandle>>;
  readonly transitions?: Readonly<Record<string, Readonly<Record<string, TransitionTargetInput>>>>;
  readonly publish?: {
    readonly key: StringExprInput;
    readonly schema?: z.ZodType | JsonSchema;
    readonly payload: ExprInput | Readonly<Record<string, ExprInput>>;
  };
}

export interface DefineTriggerInput {
  readonly id?: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly on: Readonly<Record<string, TriggerBindingIR>>;
  readonly intake?: JsonObject;
  readonly inputs?: Readonly<Record<string, InputSpecIR>>;
  readonly values?: Readonly<Record<string, ExprInput>>;
  readonly maxRuntime?: DurationInput;
  readonly run: AgentStepConfig;
}

function collectStepBlueprints(input: DefineWorkflowInput): Map<string, StepBlueprint> {
  const blueprintMap = new Map<string, StepBlueprint>();
  if (input.steps !== undefined) {
    for (const [key, entry] of Object.entries(input.steps)) {
      if (isStepHandle(entry)) {
        if (entry.id !== key) {
          throw new Error(`step handle id "${entry.id}" does not match steps key "${key}"`);
        }
        blueprintMap.set(key, entry.blueprint);
      } else {
        blueprintMap.set(key, entry);
      }
    }
  }

  // Also collect handles referenced by `initial` or `transitions` when authored handle-first.
  if (isStepHandle(input.initial) && !blueprintMap.has(input.initial.id)) {
    blueprintMap.set(input.initial.id, input.initial.blueprint);
  }
  if (input.transitions !== undefined) {
    for (const targetMap of Object.values(input.transitions)) {
      for (const target of Object.values(targetMap)) {
        if (isStepHandle(target) && !blueprintMap.has(target.id)) {
          blueprintMap.set(target.id, target.blueprint);
        }
      }
    }
  }
  return blueprintMap;
}

/**
 * Compile a declarative multi-step workflow into pure validated JSON `WorkflowIR` (zero closures).
 */
export function defineWorkflow(input: DefineWorkflowInput): WorkflowIR {
  const workflowId = input.id ?? input.name;
  if (workflowId === undefined || workflowId.trim().length === 0) {
    throw new Error("defineWorkflow requires a non-empty id (or name)");
  }

  const blueprintMap = collectStepBlueprints(input);
  const states: Record<string, StepIR> = {};
  for (const [stepId, blueprint] of blueprintMap.entries()) {
    const extraTransitions = input.transitions?.[stepId];
    states[stepId] = blueprint.compile(stepId, extraTransitions);
  }

  const initialId = isStepHandle(input.initial) ? input.initial.id : input.initial;
  const ir = assembleWorkflowIR({
    id: workflowId,
    enabled: input.enabled ?? true,
    on: input.on,
    intake: input.intake,
    inputs: input.inputs,
    values: input.values === undefined ? undefined : compileExprRecord(input.values),
    subject:
      input.subject === undefined
        ? undefined
        : {
            key: toStringExprNode(input.subject.key),
            onConflict: input.subject.onConflict ?? "ignore",
          },
    maxRuntimeMs:
      input.maxRuntime === undefined ? undefined : parseDurationMs(input.maxRuntime, "maxRuntime"),
    initial: initialId,
    states,
    publish: input.publish === undefined ? undefined : compilePublish(input.publish),
  });

  return validateWorkflowIR(ir);
}

/**
 * Compile a 1-state trigger shorthand (`name`, `on`, `run`) into the exact same
 * 1-state `WorkflowIR` (`initial: "run"`, `states.run.kind === "agent"`).
 */
export function defineTrigger(input: DefineTriggerInput): WorkflowIR {
  const workflowId = input.id ?? input.name;
  if (workflowId === undefined || workflowId.trim().length === 0) {
    throw new Error("defineTrigger requires a non-empty name (or id)");
  }

  const runConfig: AgentStepConfig = {
    ...input.run,
    on: input.run.on ?? { ok: terminal.done() },
  };

  return defineWorkflow({
    id: workflowId,
    enabled: input.enabled ?? true,
    on: input.on,
    intake: input.intake,
    inputs: input.inputs,
    values: input.values,
    maxRuntime: input.maxRuntime,
    initial: "run",
    steps: {
      run: buildAgentBlueprint(runConfig),
    },
  });
}

/** Idempotently validate and return pure JSON `WorkflowIR`. */
export function compileWorkflow(workflow: WorkflowIR): WorkflowIR {
  return validateWorkflowIR(JSON.parse(JSON.stringify(workflow)));
}

function normalizeTriggerBindings(
  on: Readonly<Record<string, TriggerBindingIR>>,
): Readonly<Record<string, TriggerBindingIR>> {
  const normalizedOn: Record<string, TriggerBindingIR> = {};
  for (const [eventName, binding] of Object.entries(on)) {
    const cleanBinding: Record<string, unknown> = {};
    if (binding.connection !== undefined) cleanBinding["connection"] = binding.connection;
    if (binding.filters !== undefined) cleanBinding["filters"] = structuredClone(binding.filters);
    if (binding.recurrence !== undefined) {
      cleanBinding["recurrence"] =
        binding.recurrence.timezone === undefined
          ? { start: binding.recurrence.start, rule: binding.recurrence.rule }
          : {
              start: binding.recurrence.start,
              rule: binding.recurrence.rule,
              timezone: binding.recurrence.timezone,
            };
    }
    normalizedOn[eventName] = cleanBinding as TriggerBindingIR;
  }
  return normalizedOn;
}

function normalizeInputSpecs(
  inputs: Readonly<Record<string, InputSpecIR>>,
): Readonly<Record<string, InputSpecIR>> {
  const cleanInputs: Record<string, InputSpecIR> = {};
  for (const [name, spec] of Object.entries(inputs)) {
    const entry: Record<string, unknown> = { type: spec.type };
    if (spec.required !== undefined) entry["required"] = spec.required;
    if (spec.default !== undefined) entry["default"] = spec.default;
    if (spec.choices !== undefined) entry["choices"] = [...spec.choices];
    cleanInputs[name] = entry as unknown as InputSpecIR;
  }
  return cleanInputs;
}

function pickDefined(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      ordered[key] = source[key];
    }
  }
  return ordered;
}

/** Canonical assembly helper shared with YAML compiler so both produce byte-identical IR. */
export function assembleWorkflowIR(parts: {
  readonly id: string;
  readonly enabled: boolean;
  readonly on: Readonly<Record<string, TriggerBindingIR>>;
  readonly intake?: JsonObject;
  readonly inputs?: Readonly<Record<string, InputSpecIR>>;
  readonly values?: Readonly<Record<string, ExprNode>>;
  readonly subject?: { readonly key: ExprNode; readonly onConflict: SubjectConflictPolicy };
  readonly maxRuntimeMs?: number;
  readonly initial: string;
  readonly states: Readonly<Record<string, StepIR>>;
  readonly publish?: WorkflowIR["publish"];
}): WorkflowIR {
  const normalized: Record<string, unknown> = {
    version: 1,
    id: parts.id,
    enabled: parts.enabled,
    on: normalizeTriggerBindings(parts.on),
    intake: parts.intake === undefined ? undefined : structuredClone(parts.intake),
    inputs:
      parts.inputs !== undefined && Object.keys(parts.inputs).length > 0
        ? normalizeInputSpecs(parts.inputs)
        : undefined,
    values:
      parts.values !== undefined && Object.keys(parts.values).length > 0 ? parts.values : undefined,
    subject:
      parts.subject === undefined
        ? undefined
        : { key: parts.subject.key, onConflict: parts.subject.onConflict },
    maxRuntimeMs: parts.maxRuntimeMs,
    initial: parts.initial,
    states: parts.states,
    publish: parts.publish,
  };

  return pickDefined(normalized, [
    "version",
    "id",
    "enabled",
    "on",
    "intake",
    "inputs",
    "values",
    "subject",
    "maxRuntimeMs",
    "initial",
    "states",
    "publish",
  ]) as unknown as WorkflowIR;
}

const STEP_KEY_ORDER: Readonly<Record<StepIR["kind"], readonly string[]>> = {
  agent: [
    "id",
    "kind",
    "when",
    "maxLoops",
    "target",
    "agent",
    "continuation",
    "title",
    "prompt",
    "maxRuntimeMs",
    "idleTimeoutMs",
    "startupTimeoutMs",
    "autoArchive",
    "background",
    "env",
    "auth",
    "tools",
    "outputSchema",
    "allowOutputs",
    "on",
  ],
  integration: [
    "id",
    "kind",
    "when",
    "maxLoops",
    "integration",
    "step",
    "input",
    "auth",
    "timeoutMs",
    "on",
  ],
  wait_workflow: [
    "id",
    "kind",
    "when",
    "maxLoops",
    "workflow",
    "outputKey",
    "dispatchIfMissing",
    "inputs",
    "timeoutMs",
    "on",
  ],
  gate: [
    "id",
    "kind",
    "when",
    "maxLoops",
    "title",
    "summary",
    "recommended",
    "choices",
    "timeoutMs",
    "on",
  ],
  sleep: ["id", "kind", "when", "maxLoops", "durationMs", "until", "on"],
};

export function canonicalizeStep(stepIr: StepIR): StepIR {
  return pickDefined(
    stepIr as unknown as Record<string, unknown>,
    STEP_KEY_ORDER[stepIr.kind],
  ) as unknown as StepIR;
}

function compilePublishPayload(
  payload: NonNullable<DefineWorkflowInput["publish"]>["payload"],
): ExprNode | Readonly<Record<string, ExprNode>> {
  if (isExprNode(payload)) {
    return payload;
  }
  if (isPlainObject(payload)) {
    return compileExprRecord(payload as Readonly<Record<string, ExprInput>>);
  }
  return toExprNode(payload as ExprInput);
}

function compilePublish(
  publish: NonNullable<DefineWorkflowInput["publish"]>,
): WorkflowIR["publish"] {
  const result: {
    key: ExprNode;
    schema?: JsonSchema;
    payload: ExprNode | Readonly<Record<string, ExprNode>>;
  } = {
    key: toStringExprNode(publish.key),
    payload: compilePublishPayload(publish.payload),
  };
  if (publish.schema !== undefined) {
    result.schema = compileSchemaInput(publish.schema);
  }
  return result;
}

function compileAgentTarget(target: AgentTargetInput): AgentTargetIR {
  const out: {
    daemon?: string;
    cwd?: string;
    environment?: string;
    worktree?: WorktreeTargetIR;
  } = {};
  if (target.daemon !== undefined) out.daemon = target.daemon;
  if (target.cwd !== undefined) out.cwd = target.cwd;
  if (target.environment !== undefined) out.environment = target.environment;
  if (target.worktree !== undefined) {
    if (target.worktree.mode === "branch-off") {
      const wt: { mode: "branch-off"; newBranch: ExprNode; base?: string } = {
        mode: "branch-off",
        newBranch: toStringExprNode(target.worktree.newBranch),
      };
      if (target.worktree.base !== undefined) {
        wt.base = target.worktree.base;
      }
      out.worktree = wt;
    } else if (target.worktree.mode === "checkout-branch") {
      out.worktree = {
        mode: "checkout-branch",
        branch: toStringExprNode(target.worktree.branch),
      };
    } else {
      out.worktree = {
        mode: "checkout-pr",
        prNumber: toExprNode(target.worktree.prNumber),
      };
    }
  }
  return out;
}

function compileAgentSpec(spec: AgentSpecIR): AgentSpecIR {
  const out: {
    provider: string;
    model?: string;
    mode?: string;
    thinkingOptionId?: string;
    options?: JsonObject;
  } = { provider: spec.provider };
  if (spec.model !== undefined) out.model = spec.model;
  if (spec.mode !== undefined) out.mode = spec.mode;
  if (spec.thinkingOptionId !== undefined) out.thinkingOptionId = spec.thinkingOptionId;
  if (spec.options !== undefined) out.options = structuredClone(spec.options);
  return out;
}

function compileAllowOutputs(
  outputs: Readonly<Record<string, AllowOutputIR>>,
): Readonly<Record<string, AllowOutputIR>> {
  const out: Record<string, AllowOutputIR> = {};
  for (const [key, entry] of Object.entries(outputs)) {
    const clean: { max?: number; required?: boolean } = {};
    if (entry.max !== undefined) clean.max = entry.max;
    if (entry.required !== undefined) clean.required = entry.required;
    out[key] = clean;
  }
  return out;
}

function compileTransitions(
  base?: Readonly<Record<string, TransitionTargetInput>>,
  extra?: Readonly<Record<string, TransitionTargetInput>>,
): Readonly<Record<string, TransitionTargetIR>> {
  const merged = { ...base, ...extra };
  const out: Record<string, TransitionTargetIR> = {};
  for (const [outcome, target] of Object.entries(merged)) {
    out[outcome] = compileTransitionTarget(target);
  }
  return out;
}

function compileTransitionTarget(target: TransitionTargetInput): TransitionTargetIR {
  if (typeof target === "string") {
    if (target === "done" || target === "succeeded") {
      return { terminal: "done" };
    }
    if (target === "failed") {
      return { terminal: "failed" };
    }
    if (target === "cancelled") {
      return { terminal: "cancelled" };
    }
    return { next: target };
  }
  if (isStepHandle(target)) {
    return { next: target.id };
  }
  if ("next" in target) {
    return { next: target.next };
  }
  const status: TerminalStatus = target.terminal === "succeeded" ? "done" : target.terminal;
  const out: {
    terminal: TerminalStatus;
    reason?: string;
    outputs?: Readonly<Record<string, ExprNode>>;
  } = { terminal: status };
  if (target.reason !== undefined) {
    out.reason = target.reason;
  }
  if (target.outputs !== undefined) {
    out.outputs = compileExprRecord(target.outputs as Readonly<Record<string, ExprInput>>);
  }
  return out;
}

function compileSchemaInput(schema: z.ZodType | JsonSchema): JsonSchema {
  if (isZodSchema(schema)) {
    return zodToJsonSchema(schema);
  }
  return normalizeJsonSchema(schema);
}

function compileExprRecord(
  record: Readonly<Record<string, ExprInput>>,
): Readonly<Record<string, ExprNode>> {
  const out: Record<string, ExprNode> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = toExprNode(value);
  }
  return out;
}

function compileStringExprRecord(
  record: Readonly<Record<string, StringExprInput>>,
): Readonly<Record<string, ExprNode>> {
  const out: Record<string, ExprNode> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = toStringExprNode(value);
  }
  return out;
}

function toStringExprNode(input: StringExprInput): ExprNode {
  if (isExprNode(input)) {
    return input;
  }
  return parseTemplateExpression(input);
}

function toConditionExpr(input: ExprNode | string): ExprNode {
  if (isExprNode(input)) {
    return input;
  }
  return parseExpression(input);
}

function toExprNode(input: ExprInput): ExprNode {
  if (isExprNode(input)) {
    return input;
  }
  if (typeof input === "string") {
    return parseTemplateExpression(input);
  }
  if (!isJsonValue(input)) {
    throw new Error("expression value must be a JSON value or ExprNode");
  }
  return { kind: "literal", value: structuredClone(input) };
}

function isExprNode(value: unknown): value is ExprNode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const kind = (value as { readonly kind?: unknown }).kind;
  return (
    kind === "literal" ||
    kind === "path" ||
    kind === "not" ||
    kind === "binary" ||
    kind === "template"
  );
}

function isStepHandle(value: unknown): value is StepHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly __kind?: unknown }).__kind === "step_handle"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJsonObjectMap(
  map: Readonly<Record<string, AuthGrantIR>>,
): Readonly<Record<string, AuthGrantIR>> {
  const out: Record<string, AuthGrantIR> = {};
  for (const [key, value] of Object.entries(map)) {
    if (!isJsonObject(value)) {
      throw new Error(`auth.${key} must be a plain JSON object`);
    }
    out[key] = structuredClone(value);
  }
  return out;
}
