import { z } from "zod";
import { parseDurationMs, type DurationInput } from "./internal/duration.js";
import {
  collectExprPaths,
  isJsonObject,
  isJsonValue,
  type BinaryOperator,
  type ExprNode,
  type ExprPath,
  type JsonObject,
  type JsonPrimitive,
  type JsonSchema,
  type JsonValue,
} from "./internal/expression.js";
import { compileJsonSchema } from "./internal/json-schema.js";
import { validateStateGraph } from "./internal/machine.js";

export type {
  BinaryOperator,
  DurationInput,
  ExprNode,
  ExprPath,
  JsonObject,
  JsonPrimitive,
  JsonSchema,
  JsonValue,
};
export { parseDurationMs };

export type TerminalStatus = "done" | "failed" | "cancelled";
export type SubjectConflictPolicy = "signal" | "queue" | "ignore" | "cancel_previous";

export type TransitionTargetIR =
  | { readonly next: string }
  | {
      readonly terminal: TerminalStatus;
      readonly reason?: string;
      readonly outputs?: Readonly<Record<string, ExprNode>>;
    };

export interface TriggerRecurrenceIR {
  readonly start: string;
  readonly rule: string;
  readonly timezone?: string;
}

export interface TriggerBindingIR {
  readonly connection?: string;
  readonly filters?: JsonObject;
  readonly recurrence?: TriggerRecurrenceIR;
}

export interface InputSpecIR {
  readonly type: "string" | "number" | "boolean";
  readonly required?: boolean;
  readonly default?: JsonPrimitive;
  readonly choices?: readonly JsonPrimitive[];
}

export type WorktreeTargetIR =
  | { readonly mode: "branch-off"; readonly newBranch: ExprNode; readonly base?: string }
  | { readonly mode: "checkout-branch"; readonly branch: ExprNode }
  | { readonly mode: "checkout-pr"; readonly prNumber: ExprNode };

export interface AgentTargetIR {
  readonly daemon?: string;
  readonly cwd?: string;
  readonly environment?: string;
  readonly worktree?: WorktreeTargetIR;
}

export interface AgentSpecIR {
  readonly provider: string;
  readonly model?: string;
  readonly mode?: string;
  readonly thinkingOptionId?: string;
  readonly options?: JsonObject;
}

export interface ContinuationIR {
  readonly mode: string;
}

export interface AuthGrantIR {
  readonly connection?: string;
  readonly [key: string]: JsonValue | undefined;
}

export interface AllowOutputIR {
  readonly max?: number;
  readonly required?: boolean;
}

export interface GateChoiceIR {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface StepBaseIR {
  readonly id: string;
  readonly when?: ExprNode;
  readonly maxLoops?: number;
  readonly on: Readonly<Record<string, TransitionTargetIR>>;
}

export interface AgentStepIR extends StepBaseIR {
  readonly kind: "agent";
  readonly target?: AgentTargetIR;
  readonly agent?: AgentSpecIR;
  readonly continuation?: ContinuationIR;
  readonly title?: ExprNode;
  readonly prompt: ExprNode;
  readonly maxRuntimeMs?: number;
  readonly idleTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly autoArchive?: boolean;
  readonly background?: boolean;
  readonly env?: Readonly<Record<string, ExprNode>>;
  readonly auth?: Readonly<Record<string, AuthGrantIR>>;
  readonly tools?: Readonly<Record<string, JsonValue>>;
  readonly outputSchema?: JsonSchema;
  readonly allowOutputs?: Readonly<Record<string, AllowOutputIR>>;
}

export interface IntegrationStepIR extends StepBaseIR {
  readonly kind: "integration";
  readonly integration: string;
  readonly step: string;
  readonly input: Readonly<Record<string, ExprNode>>;
  readonly auth?: Readonly<Record<string, AuthGrantIR>>;
  readonly timeoutMs?: number;
}

export interface WaitWorkflowStepIR extends StepBaseIR {
  readonly kind: "wait_workflow";
  readonly workflow: string;
  readonly outputKey: ExprNode;
  readonly dispatchIfMissing?: boolean;
  readonly inputs?: Readonly<Record<string, ExprNode>>;
  readonly timeoutMs?: number;
}

export interface GateStepIR extends StepBaseIR {
  readonly kind: "gate";
  readonly title: ExprNode;
  readonly summary?: ExprNode;
  readonly recommended?: string;
  readonly choices: readonly GateChoiceIR[];
  readonly timeoutMs?: number;
}

export interface SleepStepIR extends StepBaseIR {
  readonly kind: "sleep";
  readonly durationMs?: number;
  readonly until?: ExprNode;
}

export type StepIR =
  | AgentStepIR
  | IntegrationStepIR
  | WaitWorkflowStepIR
  | GateStepIR
  | SleepStepIR;

export interface WorkflowSubjectIR {
  readonly key: ExprNode;
  readonly onConflict: SubjectConflictPolicy;
}

export interface WorkflowPublishIR {
  readonly key: ExprNode;
  readonly schema?: JsonSchema;
  readonly payload: Readonly<Record<string, ExprNode>> | ExprNode;
}

export interface WorkflowIR {
  readonly version: 1;
  readonly id: string;
  readonly enabled: boolean;
  readonly on: Readonly<Record<string, TriggerBindingIR>>;
  readonly intake?: JsonObject;
  readonly inputs?: Readonly<Record<string, InputSpecIR>>;
  readonly values?: Readonly<Record<string, ExprNode>>;
  readonly subject?: WorkflowSubjectIR;
  readonly maxRuntimeMs?: number;
  readonly initial: string;
  readonly states: Readonly<Record<string, StepIR>>;
  readonly publish?: WorkflowPublishIR;
}

export interface WorkflowValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class WorkflowValidationError extends Error {
  constructor(readonly issues: readonly WorkflowValidationIssue[]) {
    super(
      `Invalid workflow IR:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`,
    );
    this.name = "WorkflowValidationError";
  }
}

const JsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(isJsonValue, {
  message: "expected a valid JSON value",
});

const JsonObjectSchema: z.ZodType<JsonObject> = z.custom<JsonObject>(isJsonObject, {
  message: "expected a plain JSON object",
});

const ExprPathSchema: z.ZodType<ExprPath> = z.union([
  z.object({ namespace: z.literal("event"), path: z.array(z.string().min(1)) }).strict(),
  z.object({ namespace: z.literal("inputs"), name: z.string().min(1) }).strict(),
  z.object({ namespace: z.literal("subject"), field: z.literal("key") }).strict(),
  z
    .object({
      namespace: z.literal("subject"),
      field: z.literal("data"),
      path: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      namespace: z.literal("steps"),
      stepId: z.string().min(1),
      field: z.enum(["outcome", "attempts"]),
    })
    .strict(),
  z
    .object({
      namespace: z.literal("steps"),
      stepId: z.string().min(1),
      field: z.literal("outputs"),
      path: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      namespace: z.literal("gate"),
      field: z.enum(["choice", "note", "actor"]),
    })
    .strict(),
  z.object({ namespace: z.literal("execution"), field: z.literal("id") }).strict(),
  z.object({ namespace: z.literal("paseo"), field: z.literal("prompt") }).strict(),
  z.object({ namespace: z.literal("values"), name: z.string().min(1) }).strict(),
]);

export const ExprNodeSchema: z.ZodType<ExprNode> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("literal"), value: JsonValueSchema }).strict(),
    z.object({ kind: z.literal("path"), path: ExprPathSchema }).strict(),
    z.object({ kind: z.literal("not"), value: ExprNodeSchema }).strict(),
    z
      .object({
        kind: z.literal("binary"),
        operator: z.enum(["==", "!=", "&&", "||", "??"]),
        left: ExprNodeSchema,
        right: ExprNodeSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("template"),
        parts: z.array(z.union([z.string(), ExprNodeSchema])),
      })
      .strict(),
  ]),
);

const TransitionTargetSchema: z.ZodType<TransitionTargetIR> = z.union([
  z.object({ next: z.string().min(1) }).strict(),
  z
    .object({
      terminal: z.enum(["done", "failed", "cancelled"]),
      reason: z.string().min(1).optional(),
      outputs: z.record(z.string().min(1), ExprNodeSchema).optional(),
    })
    .strict(),
]);

const TriggerRecurrenceSchema = z
  .object({
    start: z.string().min(1),
    rule: z.string().min(1),
    timezone: z.string().min(1).optional(),
  })
  .strict();

const TriggerBindingSchema: z.ZodType<TriggerBindingIR> = z
  .object({
    connection: z.string().min(1).optional(),
    filters: JsonObjectSchema.optional(),
    recurrence: TriggerRecurrenceSchema.optional(),
  })
  .strict();

const InputValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

const InputSpecSchema: z.ZodType<InputSpecIR> = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().optional(),
    default: InputValueSchema.optional(),
    choices: z.array(InputValueSchema).min(1).optional(),
  })
  .strict();

const WorktreeTargetSchema: z.ZodType<WorktreeTargetIR> = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("branch-off"),
      newBranch: ExprNodeSchema,
      base: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ mode: z.literal("checkout-branch"), branch: ExprNodeSchema }).strict(),
  z.object({ mode: z.literal("checkout-pr"), prNumber: ExprNodeSchema }).strict(),
]);

const AgentTargetSchema: z.ZodType<AgentTargetIR> = z
  .object({
    daemon: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    environment: z.string().min(1).optional(),
    worktree: WorktreeTargetSchema.optional(),
  })
  .strict();

const AgentSpecSchema: z.ZodType<AgentSpecIR> = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
    options: JsonObjectSchema.optional(),
  })
  .strict();

const ContinuationSchema: z.ZodType<ContinuationIR> = z
  .object({ mode: z.string().min(1) })
  .strict();

const AuthGrantSchema: z.ZodType<AuthGrantIR> = z.custom<AuthGrantIR>(
  (value) => isJsonObject(value),
  { message: "auth grant must be a plain JSON object" },
);

const AllowOutputSchema: z.ZodType<AllowOutputIR> = z
  .object({
    max: z.number().int().positive().optional(),
    required: z.boolean().optional(),
  })
  .strict();

const GateChoiceSchema: z.ZodType<GateChoiceIR> = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();

const StepBaseFields = {
  id: z.string().min(1),
  when: ExprNodeSchema.optional(),
  maxLoops: z.number().int().positive().optional(),
  on: z.record(z.string().min(1), TransitionTargetSchema),
};

const AgentStepSchema = z
  .object({
    ...StepBaseFields,
    kind: z.literal("agent"),
    target: AgentTargetSchema.optional(),
    agent: AgentSpecSchema.optional(),
    continuation: ContinuationSchema.optional(),
    title: ExprNodeSchema.optional(),
    prompt: ExprNodeSchema,
    maxRuntimeMs: z.number().int().positive().optional(),
    idleTimeoutMs: z.number().int().positive().optional(),
    startupTimeoutMs: z.number().int().positive().optional(),
    autoArchive: z.boolean().optional(),
    background: z.boolean().optional(),
    env: z.record(z.string().min(1), ExprNodeSchema).optional(),
    auth: z.record(z.string().min(1), AuthGrantSchema).optional(),
    tools: z.record(z.string().min(1), JsonValueSchema).optional(),
    outputSchema: JsonObjectSchema.optional(),
    allowOutputs: z.record(z.string().min(1), AllowOutputSchema).optional(),
  })
  .strict();

const IntegrationStepSchema = z
  .object({
    ...StepBaseFields,
    kind: z.literal("integration"),
    integration: z.string().min(1),
    step: z.string().min(1),
    input: z.record(z.string().min(1), ExprNodeSchema),
    auth: z.record(z.string().min(1), AuthGrantSchema).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const WaitWorkflowStepSchema = z
  .object({
    ...StepBaseFields,
    kind: z.literal("wait_workflow"),
    workflow: z.string().min(1),
    outputKey: ExprNodeSchema,
    dispatchIfMissing: z.boolean().optional(),
    inputs: z.record(z.string().min(1), ExprNodeSchema).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const GateStepSchema = z
  .object({
    ...StepBaseFields,
    kind: z.literal("gate"),
    title: ExprNodeSchema,
    summary: ExprNodeSchema.optional(),
    recommended: z.string().min(1).optional(),
    choices: z.array(GateChoiceSchema).min(1),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const SleepStepSchema = z
  .object({
    ...StepBaseFields,
    kind: z.literal("sleep"),
    durationMs: z.number().int().positive().optional(),
    until: ExprNodeSchema.optional(),
  })
  .strict();

const StepIRSchema: z.ZodType<StepIR> = z.discriminatedUnion("kind", [
  AgentStepSchema,
  IntegrationStepSchema,
  WaitWorkflowStepSchema,
  GateStepSchema,
  SleepStepSchema,
]);

export const WorkflowIRSchema: z.ZodType<WorkflowIR> = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    enabled: z.boolean(),
    on: z.record(z.string().min(1), TriggerBindingSchema),
    intake: JsonObjectSchema.optional(),
    inputs: z.record(z.string().min(1), InputSpecSchema).optional(),
    values: z.record(z.string().min(1), ExprNodeSchema).optional(),
    subject: z
      .object({
        key: ExprNodeSchema,
        onConflict: z.enum(["signal", "queue", "ignore", "cancel_previous"]),
      })
      .strict()
      .optional(),
    maxRuntimeMs: z.number().int().positive().optional(),
    initial: z.string().min(1),
    states: z.record(z.string().min(1), StepIRSchema),
    publish: z
      .object({
        key: ExprNodeSchema,
        schema: JsonObjectSchema.optional(),
        payload: z.union([ExprNodeSchema, z.record(z.string().min(1), ExprNodeSchema)]),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Validate a `WorkflowIR` structurally and statically:
 * - Schema shape (pure JSON, zero closures)
 * - Initial state and all transition targets exist (or valid terminals)
 * - Every cycle contains a state with `maxLoops` and an `on.max_loops_exceeded` transition
 * - All `steps.<id>.*` expression references point to existing states
 * - Gate choices are unique and `recommended` matches a declared choice
 * - Sleep steps declare either `durationMs` or `until` (not neither, not both)
 * - Output and publish JSON Schemas compile under strict AJV
 */
function validateStepDefinition(
  key: string,
  step: StepIR,
  issues: WorkflowValidationIssue[],
): void {
  if (step.id !== key) {
    issues.push({
      path: `states.${key}.id`,
      message: `step id "${step.id}" must match state key "${key}"`,
    });
  }

  if (step.kind === "gate") {
    const seenChoiceIds = new Set<string>();
    for (const choice of step.choices) {
      if (seenChoiceIds.has(choice.id)) {
        issues.push({
          path: `states.${key}.choices`,
          message: `duplicate gate choice id "${choice.id}"`,
        });
      }
      seenChoiceIds.add(choice.id);
    }
    if (step.recommended !== undefined && !seenChoiceIds.has(step.recommended)) {
      issues.push({
        path: `states.${key}.recommended`,
        message: `recommended choice "${step.recommended}" is not in choices`,
      });
    }
  }

  if (step.kind === "sleep" && (step.durationMs !== undefined) === (step.until !== undefined)) {
    issues.push({
      path: `states.${key}`,
      message: "sleep step must specify exactly one of durationMs or until",
    });
  }

  if (step.kind === "agent" && step.outputSchema !== undefined) {
    try {
      compileJsonSchema(step.outputSchema);
    } catch (error) {
      issues.push({
        path: `states.${key}.outputSchema`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function validateWorkflowIR(input: unknown): WorkflowIR {
  const parsed = WorkflowIRSchema.safeParse(input);
  if (!parsed.success) {
    throw new WorkflowValidationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.length === 0 ? "$" : issue.path.join("."),
        message: issue.message,
      })),
    );
  }

  const ir = parsed.data;
  const issues: WorkflowValidationIssue[] = [];
  const stateIds = new Set(Object.keys(ir.states));

  if (stateIds.size === 0) {
    issues.push({ path: "states", message: "workflow must declare at least one state" });
  }
  if (!stateIds.has(ir.initial)) {
    issues.push({
      path: "initial",
      message: `initial state "${ir.initial}" does not exist in states`,
    });
  }

  for (const [key, step] of Object.entries(ir.states)) {
    validateStepDefinition(key, step, issues);
  }

  if (ir.publish?.schema !== undefined) {
    try {
      compileJsonSchema(ir.publish.schema);
    } catch (error) {
      issues.push({
        path: "publish.schema",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  issues.push(...validateStateGraph(ir.states));
  issues.push(...validateExpressionReferences(ir, stateIds));

  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }

  return ir;
}

function validateStepExpressionReferences(
  prefix: string,
  step: StepIR,
  checkExpr: (expr: ExprNode | undefined, location: string) => void,
): void {
  checkExpr(step.when, `${prefix}.when`);
  for (const [outcome, target] of Object.entries(step.on)) {
    if ("terminal" in target && target.outputs !== undefined) {
      for (const [outKey, outExpr] of Object.entries(target.outputs)) {
        checkExpr(outExpr, `${prefix}.on.${outcome}.outputs.${outKey}`);
      }
    }
  }
  switch (step.kind) {
    case "agent":
      checkExpr(step.title, `${prefix}.title`);
      checkExpr(step.prompt, `${prefix}.prompt`);
      if (step.target?.worktree !== undefined) {
        const wt = step.target.worktree;
        if (wt.mode === "branch-off") {
          checkExpr(wt.newBranch, `${prefix}.target.worktree.newBranch`);
        } else if (wt.mode === "checkout-branch") {
          checkExpr(wt.branch, `${prefix}.target.worktree.branch`);
        } else {
          checkExpr(wt.prNumber, `${prefix}.target.worktree.prNumber`);
        }
      }
      if (step.env !== undefined) {
        for (const [envKey, envExpr] of Object.entries(step.env)) {
          checkExpr(envExpr, `${prefix}.env.${envKey}`);
        }
      }
      break;
    case "integration":
      for (const [inputKey, inputExpr] of Object.entries(step.input)) {
        checkExpr(inputExpr, `${prefix}.input.${inputKey}`);
      }
      break;
    case "wait_workflow":
      checkExpr(step.outputKey, `${prefix}.outputKey`);
      if (step.inputs !== undefined) {
        for (const [inputKey, inputExpr] of Object.entries(step.inputs)) {
          checkExpr(inputExpr, `${prefix}.inputs.${inputKey}`);
        }
      }
      break;
    case "gate":
      checkExpr(step.title, `${prefix}.title`);
      checkExpr(step.summary, `${prefix}.summary`);
      break;
    case "sleep":
      checkExpr(step.until, `${prefix}.until`);
      break;
  }
}

function validateExpressionReferences(
  ir: WorkflowIR,
  stateIds: ReadonlySet<string>,
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const declaredValues = new Set(Object.keys(ir.values ?? {}));

  const checkExpr = (expr: ExprNode | undefined, location: string): void => {
    if (expr === undefined) {
      return;
    }
    for (const refPath of collectExprPaths(expr)) {
      if (refPath.namespace === "steps" && !stateIds.has(refPath.stepId)) {
        issues.push({
          path: location,
          message: `expression references unknown step "${refPath.stepId}"`,
        });
      }
      if (refPath.namespace === "values" && !declaredValues.has(refPath.name)) {
        issues.push({
          path: location,
          message: `expression references undeclared value "${refPath.name}"`,
        });
      }
    }
  };

  checkExpr(ir.subject?.key, "subject.key");
  for (const [name, valueExpr] of Object.entries(ir.values ?? {})) {
    checkExpr(valueExpr, `values.${name}`);
  }
  if (ir.publish !== undefined) {
    checkExpr(ir.publish.key, "publish.key");
    if ("kind" in ir.publish.payload) {
      checkExpr(ir.publish.payload as ExprNode, "publish.payload");
    } else {
      for (const [field, fieldExpr] of Object.entries(ir.publish.payload)) {
        checkExpr(fieldExpr, `publish.payload.${field}`);
      }
    }
  }

  for (const [stateId, step] of Object.entries(ir.states)) {
    validateStepExpressionReferences(`states.${stateId}`, step, checkExpr);
  }

  return issues;
}
