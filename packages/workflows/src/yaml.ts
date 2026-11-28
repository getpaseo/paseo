import { load as parseYaml } from "js-yaml";
import { assembleWorkflowIR, canonicalizeStep } from "./dsl.js";
import { parseDurationMs } from "./internal/duration.js";
import {
  isJsonObject,
  isJsonValue,
  parseExpression,
  parseTemplateExpression,
  type ExprNode,
  type JsonObject,
  type JsonPrimitive,
  type JsonSchema,
  type JsonValue,
} from "./internal/expression.js";
import { normalizeJsonSchema } from "./internal/json-schema.js";
import {
  validateWorkflowIR,
  type AgentSpecIR,
  type AgentStepIR,
  type AgentTargetIR,
  type AllowOutputIR,
  type AuthGrantIR,
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

export class WorkflowYamlError extends Error {
  constructor(
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${path}: ${message}`, options);
    this.name = "WorkflowYamlError";
  }
}

const KNOWN_AGENT_STEP_KEYS = new Set([
  "kind",
  "when",
  "if",
  "max_loops",
  "maxLoops",
  "target",
  "agent",
  "continuation",
  "title",
  "prompt",
  "max_runtime",
  "maxRuntime",
  "idle_timeout",
  "idleTimeout",
  "startup_timeout",
  "startupTimeout",
  "auto_archive",
  "autoArchive",
  "background",
  "env",
  "auth",
  "tools",
  "output",
  "outputs",
  "allow_outputs",
  "allowOutputs",
  "on",
]);

/**
 * Compile a YAML workflow document into pure validated JSON `WorkflowIR`.
 * Supports both multi-state workflows (`initial` + `states`/`steps`) and existing
 * 1-state Hub trigger shorthand (`name` + `on` + `run`).
 */
export function compileWorkflowYaml(source: string): WorkflowIR {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new WorkflowYamlError("$", "failed to parse YAML", { cause: error });
  }
  return compileWorkflowObject(raw);
}

/** Compile an already-parsed plain YAML object into pure validated JSON `WorkflowIR`. */
export function compileWorkflowObject(raw: unknown): WorkflowIR {
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError("$", "workflow document must be a YAML mapping");
  }

  const id = readOptionalString(raw, "id", "$") ?? readOptionalString(raw, "name", "$");
  if (id === undefined || id.trim().length === 0) {
    throw new WorkflowYamlError("$", 'workflow requires a non-empty "id" or "name"');
  }

  const enabled = readOptionalBoolean(raw, "enabled", "$") ?? true;
  const on = parseOnRecord(raw["on"], "on");
  const intake = parseOptionalJsonObject(raw["intake"], "intake");
  const inputs = parseOptionalInputs(raw["inputs"], "inputs");
  const values = parseOptionalExprRecord(raw["values"], "values");
  const maxRuntimeRaw = raw["max_runtime"] ?? raw["maxRuntime"];
  const maxRuntimeMs =
    maxRuntimeRaw === undefined ? undefined : parseYamlDuration(maxRuntimeRaw, "max_runtime");

  const hasRun = raw["run"] !== undefined;
  const hasStates = raw["states"] !== undefined || raw["steps"] !== undefined;
  if (hasRun && hasStates) {
    throw new WorkflowYamlError("$", 'workflow cannot declare both "run" and "states"/"steps"');
  }

  let initial: string;
  let states: Record<string, StepIR>;

  if (hasRun) {
    if (!isPlainObject(raw["run"])) {
      throw new WorkflowYamlError("run", '"run" must be a mapping');
    }
    initial = "run";
    states = {
      run: parseAgentStep("run", raw["run"], "run", true),
    };
  } else {
    const rawStates = raw["states"] ?? raw["steps"];
    if (!isPlainObject(rawStates)) {
      throw new WorkflowYamlError("$", 'workflow must declare "states" (or 1-state "run")');
    }
    const rawInitial = readOptionalString(raw, "initial", "$");
    if (rawInitial === undefined) {
      throw new WorkflowYamlError("$", 'multi-state workflow requires "initial"');
    }
    initial = rawInitial;
    states = {};
    for (const [stateId, stateBody] of Object.entries(rawStates)) {
      states[stateId] = parseStep(stateId, stateBody, `states.${stateId}`);
    }
  }

  const subject = parseOptionalSubject(raw["subject"], "subject");
  const publish = parseOptionalPublish(raw["publish"], "publish");

  const ir = assembleWorkflowIR({
    id,
    enabled,
    on,
    intake,
    inputs,
    values,
    subject,
    maxRuntimeMs,
    initial,
    states,
    publish,
  });

  return validateWorkflowIR(ir);
}

function parseOnRecord(value: unknown, path: string): Readonly<Record<string, TriggerBindingIR>> {
  if (!isPlainObject(value)) {
    throw new WorkflowYamlError(path, '"on" must be a mapping of event names to trigger bindings');
  }
  const out: Record<string, TriggerBindingIR> = {};
  for (const [eventName, rawBinding] of Object.entries(value)) {
    if (rawBinding === null || rawBinding === undefined) {
      out[eventName] = {};
      continue;
    }
    if (!isPlainObject(rawBinding)) {
      throw new WorkflowYamlError(`${path}.${eventName}`, "trigger binding must be a mapping");
    }
    const binding: {
      connection?: string;
      filters?: JsonObject;
      recurrence?: TriggerBindingIR["recurrence"];
    } = {};
    const connection = readOptionalString(rawBinding, "connection", `${path}.${eventName}`);
    if (connection !== undefined) {
      binding.connection = connection;
    }
    const filters = parseOptionalJsonObject(rawBinding["filters"], `${path}.${eventName}.filters`);
    if (filters !== undefined) {
      binding.filters = filters;
    }
    if (rawBinding["recurrence"] !== undefined) {
      const rec = rawBinding["recurrence"];
      if (!isPlainObject(rec)) {
        throw new WorkflowYamlError(
          `${path}.${eventName}.recurrence`,
          "recurrence must be a mapping",
        );
      }
      const start = readRequiredString(rec, "start", `${path}.${eventName}.recurrence`);
      const rule = readRequiredString(rec, "rule", `${path}.${eventName}.recurrence`);
      const timezone = readOptionalString(rec, "timezone", `${path}.${eventName}.recurrence`);
      binding.recurrence = timezone === undefined ? { start, rule } : { start, rule, timezone };
    }
    out[eventName] = binding;
  }
  return out;
}

function parseStep(stateId: string, raw: unknown, path: string): StepIR {
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, "step definition must be a mapping");
  }
  const kind = readRequiredString(raw, "kind", path);

  if (kind === "agent") {
    return parseAgentStep(stateId, raw, path, false);
  }
  if (kind === "wait.workflow" || kind === "wait_workflow") {
    return parseWaitWorkflowStep(stateId, raw, path);
  }
  if (kind === "gate") {
    return parseGateStep(stateId, raw, path);
  }
  if (kind === "sleep") {
    return parseSleepStep(stateId, raw, path);
  }
  if (kind === "integration") {
    const integration = readRequiredString(raw, "integration", path);
    const stepName = readRequiredString(raw, "step", path);
    return parseIntegrationStep(stateId, integration, stepName, raw, path);
  }
  const dotIndex = kind.indexOf(".");
  if (dotIndex > 0 && dotIndex < kind.length - 1) {
    const integration = kind.slice(0, dotIndex);
    const stepName = kind.slice(dotIndex + 1);
    return parseIntegrationStep(stateId, integration, stepName, raw, path);
  }
  throw new WorkflowYamlError(`${path}.kind`, `unsupported step kind "${kind}"`);
}

function parseOptionalYamlDuration(raw: unknown, path: string): number | undefined {
  return raw === undefined ? undefined : parseYamlDuration(raw, path);
}

function parseAgentTransitions(
  rawOn: unknown,
  path: string,
  isShorthand: boolean,
): Readonly<Record<string, TransitionTargetIR>> {
  if (rawOn !== undefined) {
    return parseTransitions(rawOn, `${path}.on`);
  }
  return isShorthand ? { ok: { terminal: "done" } } : {};
}

function parseAgentStep(
  stateId: string,
  raw: Record<string, unknown>,
  path: string,
  isShorthand: boolean,
): AgentStepIR {
  const titleRaw = readOptionalString(raw, "title", path);
  const autoArchiveKey = raw["auto_archive"] !== undefined ? "auto_archive" : "autoArchive";
  const allowOutputsRaw = raw["allow_outputs"] ?? raw["allowOutputs"] ?? raw["outputs"];

  const step: AgentStepIR = {
    id: stateId,
    kind: "agent",
    when: parseOptionalCondition(raw["when"] ?? raw["if"], `${path}.when`),
    maxLoops: parseOptionalPositiveInt(raw["max_loops"] ?? raw["maxLoops"], `${path}.max_loops`),
    target: parseOptionalAgentTarget(raw["target"], `${path}.target`),
    agent: parseOptionalAgentSpec(raw["agent"], `${path}.agent`),
    continuation: parseOptionalContinuation(raw["continuation"], `${path}.continuation`),
    title: titleRaw === undefined ? undefined : parseTemplateExpression(titleRaw),
    prompt: parsePromptField(raw["prompt"], `${path}.prompt`),
    maxRuntimeMs: parseOptionalYamlDuration(
      raw["max_runtime"] ?? raw["maxRuntime"],
      `${path}.max_runtime`,
    ),
    idleTimeoutMs: parseOptionalYamlDuration(
      raw["idle_timeout"] ?? raw["idleTimeout"],
      `${path}.idle_timeout`,
    ),
    startupTimeoutMs: parseOptionalYamlDuration(
      raw["startup_timeout"] ?? raw["startupTimeout"],
      `${path}.startup_timeout`,
    ),
    autoArchive: readOptionalBoolean(raw, autoArchiveKey, path),
    background: readOptionalBoolean(raw, "background", path),
    env: parseOptionalStringExprRecord(raw["env"], `${path}.env`),
    auth: parseStepAuth(raw, path, KNOWN_AGENT_STEP_KEYS),
    tools: parseOptionalTools(raw["tools"], `${path}.tools`),
    outputSchema: parseOptionalOutputSchema(raw["output"], `${path}.output`),
    allowOutputs: parseOptionalAllowOutputs(allowOutputsRaw, `${path}.outputs`),
    on: parseAgentTransitions(raw["on"], path, isShorthand),
  };

  return canonicalizeStep(step) as AgentStepIR;
}

function parseIntegrationStep(
  stateId: string,
  integration: string,
  stepName: string,
  raw: Record<string, unknown>,
  path: string,
): IntegrationStepIR {
  const when = parseOptionalCondition(raw["when"] ?? raw["if"], `${path}.when`);
  const maxLoops = parseOptionalPositiveInt(
    raw["max_loops"] ?? raw["maxLoops"],
    `${path}.max_loops`,
  );
  const inputRaw = raw["input"];
  const input = inputRaw === undefined ? {} : parseExprRecord(inputRaw, `${path}.input`);
  const auth = parseExplicitAuth(raw["auth"], `${path}.auth`);
  const timeoutRaw = raw["timeout"];
  const timeoutMs =
    timeoutRaw === undefined ? undefined : parseYamlDuration(timeoutRaw, `${path}.timeout`);
  const on = parseTransitions(raw["on"] ?? {}, `${path}.on`);

  const step: {
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
    id: stateId,
    kind: "integration",
    integration,
    step: stepName,
    input,
    on,
  };
  if (when !== undefined) step.when = when;
  if (maxLoops !== undefined) step.maxLoops = maxLoops;
  if (auth !== undefined) step.auth = auth;
  if (timeoutMs !== undefined) step.timeoutMs = timeoutMs;
  return canonicalizeStep(step) as IntegrationStepIR;
}

function parseWaitWorkflowStep(
  stateId: string,
  raw: Record<string, unknown>,
  path: string,
): WaitWorkflowStepIR {
  const when = parseOptionalCondition(raw["when"] ?? raw["if"], `${path}.when`);
  const maxLoops = parseOptionalPositiveInt(
    raw["max_loops"] ?? raw["maxLoops"],
    `${path}.max_loops`,
  );
  const workflow = readRequiredString(raw, "workflow", path);
  const outputKeyRaw =
    readOptionalString(raw, "output_key", path) ??
    readOptionalString(raw, "outputKey", path) ??
    readOptionalString(raw, "correlation_key", path) ??
    readOptionalString(raw, "correlationKey", path);
  if (outputKeyRaw === undefined) {
    throw new WorkflowYamlError(
      path,
      'wait.workflow step requires "output_key" or "correlation_key"',
    );
  }
  const dispatchRaw = raw["dispatch_if_missing"] ?? raw["dispatchIfMissing"];
  if (dispatchRaw !== undefined && typeof dispatchRaw !== "boolean") {
    throw new WorkflowYamlError(`${path}.dispatch_if_missing`, "must be a boolean");
  }
  const inputs =
    raw["inputs"] === undefined ? undefined : parseExprRecord(raw["inputs"], `${path}.inputs`);
  const timeoutRaw = raw["timeout"];
  const timeoutMs =
    timeoutRaw === undefined ? undefined : parseYamlDuration(timeoutRaw, `${path}.timeout`);
  const on = parseTransitions(raw["on"] ?? {}, `${path}.on`);

  const step: {
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
    id: stateId,
    kind: "wait_workflow",
    workflow,
    outputKey: parseTemplateExpression(outputKeyRaw),
    on,
  };
  if (when !== undefined) step.when = when;
  if (maxLoops !== undefined) step.maxLoops = maxLoops;
  if (dispatchRaw !== undefined) step.dispatchIfMissing = dispatchRaw;
  if (inputs !== undefined) step.inputs = inputs;
  if (timeoutMs !== undefined) step.timeoutMs = timeoutMs;
  return canonicalizeStep(step) as WaitWorkflowStepIR;
}

function parseGateStep(stateId: string, raw: Record<string, unknown>, path: string): GateStepIR {
  const when = parseOptionalCondition(raw["when"] ?? raw["if"], `${path}.when`);
  const maxLoops = parseOptionalPositiveInt(
    raw["max_loops"] ?? raw["maxLoops"],
    `${path}.max_loops`,
  );
  const title = readRequiredString(raw, "title", path);
  const summary = readOptionalString(raw, "summary", path);
  const recommended = readOptionalString(raw, "recommended", path);
  if (!Array.isArray(raw["choices"]) || raw["choices"].length === 0) {
    throw new WorkflowYamlError(`${path}.choices`, "gate step requires a non-empty choices array");
  }
  const choices: GateChoiceIR[] = raw["choices"].map((entry, index) => {
    const choicePath = `${path}.choices[${index}]`;
    if (!isPlainObject(entry)) {
      throw new WorkflowYamlError(choicePath, "gate choice must be a mapping");
    }
    const choiceId = readRequiredString(entry, "id", choicePath);
    const label = readRequiredString(entry, "label", choicePath);
    const description = readOptionalString(entry, "description", choicePath);
    return description === undefined
      ? { id: choiceId, label }
      : { id: choiceId, label, description };
  });
  const timeoutRaw = raw["timeout"];
  const timeoutMs =
    timeoutRaw === undefined ? undefined : parseYamlDuration(timeoutRaw, `${path}.timeout`);

  const on = { ...parseTransitions(raw["on"] ?? {}, `${path}.on`) };
  const onTimeoutRaw = raw["on_timeout"] ?? raw["onTimeout"];
  if (onTimeoutRaw !== undefined && on["timeout"] === undefined) {
    on["timeout"] = parseTransitionTarget(onTimeoutRaw, `${path}.on_timeout`);
  }

  const step: {
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
    id: stateId,
    kind: "gate",
    title: parseTemplateExpression(title),
    choices,
    on,
  };
  if (when !== undefined) step.when = when;
  if (maxLoops !== undefined) step.maxLoops = maxLoops;
  if (summary !== undefined) step.summary = parseTemplateExpression(summary);
  if (recommended !== undefined) step.recommended = recommended;
  if (timeoutMs !== undefined) step.timeoutMs = timeoutMs;
  return canonicalizeStep(step) as GateStepIR;
}

function parseSleepStep(stateId: string, raw: Record<string, unknown>, path: string): SleepStepIR {
  const when = parseOptionalCondition(raw["when"] ?? raw["if"], `${path}.when`);
  const maxLoops = parseOptionalPositiveInt(
    raw["max_loops"] ?? raw["maxLoops"],
    `${path}.max_loops`,
  );
  const durationRaw = raw["duration"];
  const durationMs =
    durationRaw === undefined ? undefined : parseYamlDuration(durationRaw, `${path}.duration`);
  const untilRaw = readOptionalString(raw, "until", path);
  const on = parseTransitions(raw["on"] ?? {}, `${path}.on`);

  const step: {
    id: string;
    kind: "sleep";
    when?: ExprNode;
    maxLoops?: number;
    durationMs?: number;
    until?: ExprNode;
    on: Readonly<Record<string, TransitionTargetIR>>;
  } = {
    id: stateId,
    kind: "sleep",
    on,
  };
  if (when !== undefined) step.when = when;
  if (maxLoops !== undefined) step.maxLoops = maxLoops;
  if (durationMs !== undefined) step.durationMs = durationMs;
  if (untilRaw !== undefined) step.until = parseTemplateExpression(untilRaw);
  return canonicalizeStep(step) as SleepStepIR;
}

function parsePromptField(value: unknown, path: string): ExprNode {
  if (typeof value === "string") {
    return parseTemplateExpression(value);
  }
  if (Array.isArray(value)) {
    const blocks: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const entry = value[i];
      if (isPlainObject(entry) && typeof entry["text"] === "string") {
        blocks.push(entry["text"]);
      } else {
        throw new WorkflowYamlError(
          `${path}[${i}]`,
          "prompt array blocks must be { text: string }",
        );
      }
    }
    return parseTemplateExpression(blocks.join("\n"));
  }
  throw new WorkflowYamlError(path, 'agent step requires a string "prompt"');
}

/**
 * Normalize explicit `auth: { <integration>: ... }` as well as legacy 1-state shorthand
 * provider blocks (`<integration>: { connection: "...", ... }`) without hardcoding any
 * provider identifiers.
 */
function parseStepAuth(
  raw: Record<string, unknown>,
  path: string,
  knownKeys: ReadonlySet<string>,
): Readonly<Record<string, AuthGrantIR>> | undefined {
  const combined: Record<string, AuthGrantIR> = {};
  const explicit = parseExplicitAuth(raw["auth"], `${path}.auth`);
  if (explicit !== undefined) {
    Object.assign(combined, explicit);
  }

  for (const [key, value] of Object.entries(raw)) {
    if (knownKeys.has(key)) {
      continue;
    }
    if (isPlainObject(value) && typeof value["connection"] === "string" && isJsonObject(value)) {
      combined[key] = structuredClone(value);
      continue;
    }
    throw new WorkflowYamlError(`${path}.${key}`, `unknown agent step property "${key}"`);
  }

  return Object.keys(combined).length === 0 ? undefined : combined;
}

function parseExplicitAuth(
  raw: unknown,
  path: string,
): Readonly<Record<string, AuthGrantIR>> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, '"auth" must be a mapping of integration id to auth grant');
  }
  const out: Record<string, AuthGrantIR> = {};
  for (const [integrationId, grant] of Object.entries(raw)) {
    if (!isJsonObject(grant)) {
      throw new WorkflowYamlError(`${path}.${integrationId}`, "auth grant must be a JSON object");
    }
    out[integrationId] = structuredClone(grant);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function parseOptionalAgentTarget(raw: unknown, path: string): AgentTargetIR | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, "target must be a mapping");
  }
  const out: {
    daemon?: string;
    cwd?: string;
    environment?: string;
    worktree?: WorktreeTargetIR;
  } = {};
  const daemon = readOptionalString(raw, "daemon", path);
  const cwd = readOptionalString(raw, "cwd", path);
  const environment = readOptionalString(raw, "environment", path);
  if (daemon !== undefined) out.daemon = daemon;
  if (cwd !== undefined) out.cwd = cwd;
  if (environment !== undefined) out.environment = environment;
  if (raw["worktree"] !== undefined) {
    out.worktree = parseWorktreeTarget(raw["worktree"], `${path}.worktree`);
  }
  return out;
}

function parseWorktreeTarget(raw: unknown, path: string): WorktreeTargetIR {
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, "worktree must be a mapping");
  }
  const mode = readRequiredString(raw, "mode", path);
  if (mode === "branch-off") {
    const newBranch = readRequiredString(raw, "newBranch", path);
    const base = readOptionalString(raw, "base", path);
    return base === undefined
      ? { mode: "branch-off", newBranch: parseTemplateExpression(newBranch) }
      : { mode: "branch-off", newBranch: parseTemplateExpression(newBranch), base };
  }
  if (mode === "checkout-branch") {
    const branch = readRequiredString(raw, "branch", path);
    return { mode: "checkout-branch", branch: parseTemplateExpression(branch) };
  }
  if (mode === "checkout-pr") {
    const prRaw = raw["prNumber"];
    if (typeof prRaw === "number") {
      return { mode: "checkout-pr", prNumber: { kind: "literal", value: prRaw } };
    }
    if (typeof prRaw === "string") {
      return { mode: "checkout-pr", prNumber: parseTemplateExpression(prRaw) };
    }
    throw new WorkflowYamlError(`${path}.prNumber`, "prNumber must be a number or expression");
  }
  throw new WorkflowYamlError(`${path}.mode`, `unsupported worktree mode "${mode}"`);
}

function parseOptionalAgentSpec(raw: unknown, path: string): AgentSpecIR | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, "agent must be a mapping");
  }
  const provider = readRequiredString(raw, "provider", path);
  const out: {
    provider: string;
    model?: string;
    mode?: string;
    thinkingOptionId?: string;
    options?: JsonObject;
  } = { provider };
  const model = readOptionalString(raw, "model", path);
  const mode = readOptionalString(raw, "mode", path);
  const thinkingOptionId = readOptionalString(raw, "thinkingOptionId", path);
  const options = parseOptionalJsonObject(raw["options"], `${path}.options`);
  if (model !== undefined) out.model = model;
  if (mode !== undefined) out.mode = mode;
  if (thinkingOptionId !== undefined) out.thinkingOptionId = thinkingOptionId;
  if (options !== undefined) out.options = options;
  return out;
}

function parseOptionalContinuation(
  raw: unknown,
  path: string,
): { readonly mode: string } | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, "continuation must be a mapping");
  }
  return { mode: readRequiredString(raw, "mode", path) };
}

function parseOptionalTools(
  raw: unknown,
  path: string,
): Readonly<Record<string, JsonValue>> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, "tools must be a mapping");
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isJsonValue(value)) {
      throw new WorkflowYamlError(`${path}.${key}`, "tool grant must be a JSON value");
    }
    out[key] = structuredClone(value);
  }
  return out;
}

function parseOptionalOutputSchema(raw: unknown, path: string): JsonSchema | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, "output must be a mapping");
  }
  const schema = raw["schema"] ?? raw;
  if (!isJsonObject(schema)) {
    throw new WorkflowYamlError(`${path}.schema`, "output schema must be a JSON Schema object");
  }
  return normalizeJsonSchema(schema);
}

function parseOptionalAllowOutputs(
  raw: unknown,
  path: string,
): Readonly<Record<string, AllowOutputIR>> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const out: Record<string, AllowOutputIR> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 1) {
      const entry = raw[i];
      if (!isPlainObject(entry)) {
        throw new WorkflowYamlError(`${path}[${i}]`, "allow_outputs entry must be a mapping");
      }
      const type = readRequiredString(entry, "type", `${path}[${i}]`);
      const max = parseOptionalPositiveInt(entry["max"], `${path}[${i}].max`);
      const required = readOptionalBoolean(entry, "required", `${path}[${i}]`);
      const clean: { max?: number; required?: boolean } = {};
      if (max !== undefined) clean.max = max;
      if (required !== undefined) clean.required = required;
      out[type] = clean;
    }
    return out;
  }
  if (isPlainObject(raw)) {
    for (const [eventType, entry] of Object.entries(raw)) {
      if (entry === null || entry === undefined) {
        out[eventType] = {};
        continue;
      }
      if (!isPlainObject(entry)) {
        throw new WorkflowYamlError(`${path}.${eventType}`, "output policy must be a mapping");
      }
      const max = parseOptionalPositiveInt(entry["max"], `${path}.${eventType}.max`);
      const required = readOptionalBoolean(entry, "required", `${path}.${eventType}`);
      const clean: { max?: number; required?: boolean } = {};
      if (max !== undefined) clean.max = max;
      if (required !== undefined) clean.required = required;
      out[eventType] = clean;
    }
    return out;
  }
  throw new WorkflowYamlError(path, "outputs must be a mapping or array");
}

function parseOptionalSubject(
  raw: unknown,
  path: string,
): { readonly key: ExprNode; readonly onConflict: SubjectConflictPolicy } | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, "subject must be a mapping");
  }
  const key = readRequiredString(raw, "key", path);
  const policyRaw = raw["on_conflict"] ?? raw["onConflict"] ?? "ignore";
  if (
    policyRaw !== "signal" &&
    policyRaw !== "queue" &&
    policyRaw !== "ignore" &&
    policyRaw !== "cancel_previous"
  ) {
    throw new WorkflowYamlError(
      `${path}.on_conflict`,
      `invalid subject conflict policy ${JSON.stringify(policyRaw)}`,
    );
  }
  return {
    key: parseTemplateExpression(key),
    onConflict: policyRaw,
  };
}

function parseOptionalPublish(raw: unknown, path: string): WorkflowIR["publish"] {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, "publish must be a mapping");
  }
  const key = readRequiredString(raw, "key", path);
  const schemaRaw = raw["schema"];
  let schema: JsonSchema | undefined;
  if (schemaRaw !== undefined) {
    if (!isJsonObject(schemaRaw)) {
      throw new WorkflowYamlError(`${path}.schema`, "publish.schema must be a JSON Schema object");
    }
    schema = normalizeJsonSchema(schemaRaw);
  }
  const payloadRaw = raw["payload"];
  if (payloadRaw === undefined) {
    throw new WorkflowYamlError(`${path}.payload`, "publish requires a payload");
  }
  const payload = isPlainObject(payloadRaw)
    ? parseExprRecord(payloadRaw, `${path}.payload`)
    : parseYamlExprValue(payloadRaw, `${path}.payload`);

  const result: {
    key: ExprNode;
    schema?: JsonSchema;
    payload: ExprNode | Readonly<Record<string, ExprNode>>;
  } = {
    key: parseTemplateExpression(key),
    payload,
  };
  if (schema !== undefined) {
    result.schema = schema;
  }
  return result;
}

function parseOptionalInputs(
  raw: unknown,
  path: string,
): Readonly<Record<string, InputSpecIR>> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, "inputs must be a mapping");
  }
  const out: Record<string, InputSpecIR> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const entryPath = `${path}.${name}`;
    if (!isPlainObject(entry)) {
      throw new WorkflowYamlError(entryPath, "input spec must be a mapping");
    }
    const type = entry["type"];
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw new WorkflowYamlError(
        `${entryPath}.type`,
        'input type must be "string", "number", or "boolean"',
      );
    }
    const spec: {
      type: InputSpecIR["type"];
      required?: boolean;
      default?: JsonPrimitive;
      choices?: readonly JsonPrimitive[];
    } = { type };
    const required = readOptionalBoolean(entry, "required", entryPath);
    if (required !== undefined) spec.required = required;
    if (entry["default"] !== undefined) {
      if (!isJsonPrimitive(entry["default"])) {
        throw new WorkflowYamlError(`${entryPath}.default`, "default must be a JSON primitive");
      }
      spec.default = entry["default"];
    }
    if (entry["choices"] !== undefined) {
      if (!Array.isArray(entry["choices"]) || !entry["choices"].every(isJsonPrimitive)) {
        throw new WorkflowYamlError(
          `${entryPath}.choices`,
          "choices must be an array of primitives",
        );
      }
      spec.choices = [...entry["choices"]];
    }
    out[name] = spec;
  }
  return out;
}

function parseTransitions(
  raw: unknown,
  path: string,
): Readonly<Record<string, TransitionTargetIR>> {
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, '"on" transitions must be a mapping');
  }
  const out: Record<string, TransitionTargetIR> = {};
  for (const [outcome, target] of Object.entries(raw)) {
    out[outcome] = parseTransitionTarget(target, `${path}.${outcome}`);
  }
  return out;
}

function parseTransitionTarget(raw: unknown, path: string): TransitionTargetIR {
  if (typeof raw === "string") {
    if (raw === "done" || raw === "succeeded") {
      return { terminal: "done" };
    }
    if (raw === "failed") {
      return { terminal: "failed" };
    }
    if (raw === "cancelled") {
      return { terminal: "cancelled" };
    }
    return { next: raw };
  }
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, "transition target must be a state name or target mapping");
  }
  if (raw["next"] !== undefined) {
    return { next: readRequiredString(raw, "next", path) };
  }
  if (raw["terminal"] !== undefined) {
    const rawStatus = readRequiredString(raw, "terminal", path);
    const status = parseTerminalStatus(rawStatus, `${path}.terminal`);
    const result: {
      terminal: TerminalStatus;
      reason?: string;
      outputs?: Readonly<Record<string, ExprNode>>;
    } = { terminal: status };
    const reason = readOptionalString(raw, "reason", path);
    if (reason !== undefined) {
      result.reason = reason;
    }
    if (raw["outputs"] !== undefined) {
      result.outputs = parseExprRecord(raw["outputs"], `${path}.outputs`);
    }
    return result;
  }
  throw new WorkflowYamlError(path, 'transition target requires "next" or "terminal"');
}

function parseTerminalStatus(rawStatus: string, path: string): TerminalStatus {
  if (rawStatus === "done" || rawStatus === "succeeded") {
    return "done";
  }
  if (rawStatus === "failed") {
    return "failed";
  }
  if (rawStatus === "cancelled") {
    return "cancelled";
  }
  throw new WorkflowYamlError(path, `invalid terminal status "${rawStatus}"`);
}

function parseOptionalCondition(raw: unknown, path: string): ExprNode | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new WorkflowYamlError(path, "condition must be a string expression");
  }
  return parseExpression(raw);
}

function parseOptionalExprRecord(
  raw: unknown,
  path: string,
): Readonly<Record<string, ExprNode>> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return parseExprRecord(raw, path);
}

function parseExprRecord(raw: unknown, path: string): Readonly<Record<string, ExprNode>> {
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, "must be a mapping");
  }
  const out: Record<string, ExprNode> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = parseYamlExprValue(value, `${path}.${key}`);
  }
  return out;
}

function parseOptionalStringExprRecord(
  raw: unknown,
  path: string,
): Readonly<Record<string, ExprNode>> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new WorkflowYamlError(path, "must be a mapping");
  }
  const out: Record<string, ExprNode> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      throw new WorkflowYamlError(`${path}.${key}`, "must be a string or template");
    }
    out[key] = parseTemplateExpression(value);
  }
  return out;
}

function parseYamlExprValue(value: unknown, path: string): ExprNode {
  if (typeof value === "string") {
    return parseTemplateExpression(value);
  }
  if (!isJsonValue(value)) {
    throw new WorkflowYamlError(path, "value must be a JSON-compatible value");
  }
  return { kind: "literal", value: structuredClone(value) };
}

function parseYamlDuration(raw: unknown, path: string): number {
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new WorkflowYamlError(path, "duration must be a string or positive number of ms");
  }
  try {
    return parseDurationMs(raw, path);
  } catch (error) {
    throw new WorkflowYamlError(path, error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

function parseOptionalPositiveInt(raw: unknown, path: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new WorkflowYamlError(path, "must be a positive integer");
  }
  return raw;
}

function parseOptionalJsonObject(raw: unknown, path: string): JsonObject | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isJsonObject(raw)) {
    throw new WorkflowYamlError(path, "must be a plain JSON object");
  }
  return structuredClone(raw);
}

function readRequiredString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkflowYamlError(`${path}.${key}`, `required non-empty string "${key}"`);
  }
  return value;
}

function readOptionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new WorkflowYamlError(`${path}.${key}`, `"${key}" must be a string`);
  }
  return value;
}

function readOptionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new WorkflowYamlError(`${path}.${key}`, `"${key}" must be a boolean`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
