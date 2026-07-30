import Ajv2020 from "ajv/dist/2020.js";
import type {
  WorkflowSpecSummary,
  WorkflowValidationIssue,
  WorkflowValidationResult,
} from "@getpaseo/protocol/workflow/types";

export type JsonObject = Record<string, unknown>;

export interface WorkflowCallerContext {
  workspaceId?: string;
  worktreePath?: string;
  agentId?: string;
}

export interface MaterializedWorkflow {
  spec: JsonObject;
  canonicalJson: string;
}

const TOP_FIELDS = new Set([
  "schemaVersion",
  "name",
  "description",
  "bindings",
  "workspace",
  "agents",
  "protocol",
  "entry",
  "flows",
  "limits",
  "inputs",
  "prompts",
  "parameters",
]);
const ACTIONS = ["turn", "call", "map", "return", "stop"] as const;
const RUNTIME_EVENTS = new Set(["error.agent", "error.protocol", "error.timeout"]);
const PARAMETER_TYPES = new Set([
  "string",
  "path",
  "image",
  "object",
  "array",
  "enum",
  "boolean",
  "integer",
  "number",
]);
const DEFAULT_FROM = new Set(["current.workspace", "current.worktree", "current.agent"]);
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const AGENT_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DURATION = /^[1-9][0-9]*(s|m|h|d)$/;
const PARAMETER_REFERENCE = /parameters\.([A-Za-z_][A-Za-z0-9_]*)/g;
const EXACT_PARAMETER = /^\s*{{\s*parameters\.([A-Za-z_][A-Za-z0-9_]*)\s*}}\s*$/;
const INLINE_PARAMETER = /{{\s*parameters\.([A-Za-z_][A-Za-z0-9_]*)\s*}}/g;
const Ajv2020Constructor = Ajv2020 as unknown as {
  new (options?: { strict?: boolean }): {
    compile: (schema: unknown) => (value: unknown) => boolean;
  };
};

class Issues {
  readonly values: WorkflowValidationIssue[] = [];

  add(path: string, message: string): void {
    if (!this.values.some((issue) => issue.path === path && issue.message === message)) {
      this.values.push({ path, message });
    }
  }

  object(value: unknown, path: string, label = "object"): value is JsonObject {
    if (!isObject(value)) {
      this.add(path, `must be a ${label}`);
      return false;
    }
    return true;
  }

  unknown(value: JsonObject, path: string, allowed: ReadonlySet<string>): void {
    for (const key of Object.keys(value).sort()) {
      if (!allowed.has(key)) {
        this.add(path === "$" ? `$.${key}` : `${path}.${key}`, "unknown field");
      }
    }
  }

  required(value: JsonObject, path: string, key: string): boolean {
    if (!(key in value)) {
      this.add(path === "$" ? `$.${key}` : `${path}.${key}`, "required");
      return false;
    }
    return true;
  }
}

export function validateWorkflowTemplate(
  value: unknown,
  source: "built-in" | "user" | "legacy" = "user",
): WorkflowValidationResult {
  const issues = new Issues();
  if (!issues.object(value, "$")) {
    return validationResult(issues, null);
  }
  issues.unknown(value, "$", TOP_FIELDS);
  if (value.schemaVersion !== "paseo.workflows.v0.2") {
    issues.add("schemaVersion", "unsupported schema version");
  }
  if (typeof value.name !== "string" || !SLUG.test(value.name)) {
    issues.add("name", "must be a lowercase slug");
  }
  if (typeof value.description !== "string" || value.description.trim().length === 0) {
    issues.add("description", "must be a non-empty string");
  }

  const parameters = validateParameters(value.parameters, issues);
  validateParameterReferences(value, parameters, issues);
  const agents = validateAgents(value.agents, issues);
  validateBindings(value.bindings, agents, issues);
  validateWorkspace(value.workspace, "workspace", issues);
  validatePrompts(value.prompts, issues);
  validateProtocol(value.protocol, issues);
  validateLimits(value.limits, issues);
  if (value.inputs !== undefined && !isObject(value.inputs)) {
    issues.add("inputs", "must be an object");
  }
  validateFlows(value.flows, value.entry, agents, value.prompts, issues);

  const summary =
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.schemaVersion === "string"
      ? ({
          id: value.name,
          name: value.name,
          description: value.description,
          version: value.schemaVersion,
          source,
          updatedAt: null,
        } satisfies WorkflowSpecSummary)
      : null;
  return validationResult(issues, summary, parameters);
}

function validationResult(
  issues: Issues,
  summary: WorkflowSpecSummary | null,
  parameters: Map<string, JsonObject> = new Map(),
): WorkflowValidationResult {
  return {
    valid: issues.values.length === 0,
    issues: issues.values,
    summary,
    parameters: [...parameters].map(([name, declaration]) =>
      buildParameterSummary(name, declaration),
    ),
  };
}

function buildParameterSummary(
  name: string,
  declaration: JsonObject,
): WorkflowValidationResult["parameters"][number] {
  let description = name;
  if (typeof declaration.description === "string") {
    description = declaration.description;
  } else if (typeof declaration.title === "string") {
    description = declaration.title;
  }
  const result: WorkflowValidationResult["parameters"][number] = {
    name,
    type: parameterType(declaration),
    description,
    required: declaration.required === true,
  };
  if ("default" in declaration) {
    result.defaultValue = declaration.default;
  }
  if (typeof declaration.defaultFrom === "string" && DEFAULT_FROM.has(declaration.defaultFrom)) {
    result.defaultFrom = declaration.defaultFrom as
      | "current.workspace"
      | "current.worktree"
      | "current.agent";
  }
  if (Array.isArray(declaration.values)) {
    result.values = declaration.values;
  }
  return result;
}

function validateParameters(value: unknown, issues: Issues): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  if (value === undefined || value === null) {
    return result;
  }
  if (!issues.object(value, "parameters")) {
    return result;
  }
  const allowed = new Set([
    "type",
    "required",
    "default",
    "defaultFrom",
    "title",
    "description",
    "values",
  ]);
  for (const [name, declaration] of Object.entries(value)) {
    const path = `parameters.${name}`;
    if (!IDENTIFIER.test(name)) {
      issues.add(path, "invalid parameter name");
    }
    if (!issues.object(declaration, path)) {
      continue;
    }
    result.set(name, declaration);
    issues.unknown(declaration, path, allowed);
    const type = parameterType(declaration);
    if (!PARAMETER_TYPES.has(type)) {
      issues.add(`${path}.type`, "invalid parameter type");
    }
    if ("required" in declaration && typeof declaration.required !== "boolean") {
      issues.add(`${path}.required`, "must be a boolean");
    }
    if ("defaultFrom" in declaration && !DEFAULT_FROM.has(String(declaration.defaultFrom))) {
      issues.add(`${path}.defaultFrom`, "unsupported source");
    }
    if (
      type === "enum" &&
      (!Array.isArray(declaration.values) || declaration.values.length === 0)
    ) {
      issues.add(`${path}.values`, "enum requires values");
    }
    if ("default" in declaration) {
      try {
        coerceParameter(name, declaration, declaration.default);
      } catch (error) {
        issues.add(path, errorMessage(error));
      }
    }
  }
  return result;
}

function validateParameterReferences(
  value: unknown,
  parameters: ReadonlyMap<string, JsonObject>,
  issues: Issues,
): void {
  const found = new Set<string>();
  collectParameterReferences(value, found, false);
  for (const name of [...found].sort()) {
    if (!parameters.has(name)) {
      issues.add(`parameters.${name}`, "referenced but not declared");
    }
  }
}

function collectParameterReferences(value: unknown, found: Set<string>, skip: boolean): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(PARAMETER_REFERENCE)) {
      found.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectParameterReferences(item, found, skip);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!skip && key === "parameters") {
      continue;
    }
    collectParameterReferences(item, found, skip);
  }
}

function validateBindings(
  value: unknown,
  agents: ReadonlyMap<string, JsonObject>,
  issues: Issues,
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!issues.object(value, "bindings")) {
    return;
  }
  issues.unknown(value, "bindings", new Set(["workspace", "worktree", "agents"]));
  const hasWorkspace = value.workspace !== undefined && value.workspace !== null;
  const hasWorktree = value.worktree !== undefined && value.worktree !== null;
  if (hasWorkspace !== hasWorktree) {
    issues.add("bindings", "workspace and worktree must be supplied together");
  }
  for (const key of ["workspace", "worktree"] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") {
      issues.add(`bindings.${key}`, "must be a string or null");
    }
  }
  if (value.agents === undefined || value.agents === null) {
    return;
  }
  validateAgentBindings(value.agents, agents, issues);
}

function validateAgentBindings(
  value: unknown,
  agents: ReadonlyMap<string, JsonObject>,
  issues: Issues,
): void {
  if (!issues.object(value, "bindings.agents")) {
    return;
  }
  for (const [name, agentId] of Object.entries(value)) {
    if (!agents.has(name)) {
      issues.add(`bindings.agents.${name}`, "unknown agent");
    }
    if (agentId !== null && (typeof agentId !== "string" || agentId.length === 0)) {
      issues.add(`bindings.agents.${name}`, "must be a string or null");
    }
    if (agentId !== null && agents.get(name)?.persistence !== "reuse-agent") {
      issues.add(`agents.${name}.persistence`, "bound agents must use reuse-agent");
    }
  }
}

function validateWorkspace(value: unknown, path: string, issues: Issues): void {
  if (!issues.object(value, path)) {
    return;
  }
  issues.unknown(value, path, new Set(["createWorktree"]));
  if (!issues.required(value, path, "createWorktree")) {
    return;
  }
  const createPath = `${path}.createWorktree`;
  if (!issues.object(value.createWorktree, createPath)) {
    return;
  }
  const create = value.createWorktree;
  issues.unknown(
    create,
    createPath,
    new Set(["cwd", "name", "prefix", "branchPrefix", "namePrefix", "target"]),
  );
  if (typeof create.cwd !== "string" || create.cwd.length === 0) {
    issues.add(`${createPath}.cwd`, "must be a string");
  }
  if (!issues.object(create.target, `${createPath}.target`)) {
    return;
  }
  const target = create.target;
  const targetPath = `${createPath}.target`;
  if (target.mode === "branch-off") {
    issues.unknown(target, targetPath, new Set(["mode", "newBranch", "base"]));
  } else if (target.mode === "checkout-branch") {
    issues.unknown(target, targetPath, new Set(["mode", "branch"]));
    if (typeof target.branch !== "string" || target.branch.length === 0) {
      issues.add(`${targetPath}.branch`, "must be a non-empty string");
    }
  } else if (target.mode === "checkout-pr") {
    issues.unknown(target, targetPath, new Set(["mode", "prNumber"]));
    if (!isPositiveIntegerOrParameter(target.prNumber)) {
      issues.add(`${targetPath}.prNumber`, "must be a positive integer");
    }
  } else {
    issues.add(`${targetPath}.mode`, "unknown mode");
  }
  for (const field of ["prefix", "branchPrefix"] as const) {
    const item = create[field];
    if (item !== undefined && (typeof item !== "string" || item.length === 0)) {
      issues.add(`${createPath}.${field}`, "must be a lowercase string");
    } else if (
      typeof item === "string" &&
      stripTemplates(item) !== stripTemplates(item).toLowerCase()
    ) {
      issues.add(`${createPath}.${field}`, "must be lowercase");
    }
  }
}

function validateAgents(value: unknown, issues: Issues): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  if (!issues.object(value, "agents") || Object.keys(value).length === 0) {
    issues.add("agents", "must be a non-empty object");
    return result;
  }
  for (const [name, declaration] of Object.entries(value)) {
    const path = `agents.${name}`;
    if (!AGENT_NAME.test(name)) {
      issues.add(path, "invalid agent name");
    }
    if (!issues.object(declaration, path)) {
      continue;
    }
    result.set(name, declaration);
    validateAgentDeclaration(declaration, path, issues);
  }
  return result;
}

function validateAgentDeclaration(declaration: JsonObject, path: string, issues: Issues): void {
  issues.unknown(declaration, path, new Set(["persistence", "createAgent"]));
  if (!["reuse-agent", "fresh-agent"].includes(String(declaration.persistence))) {
    issues.add(`${path}.persistence`, "must be reuse-agent or fresh-agent");
  }
  if (!issues.object(declaration.createAgent, `${path}.createAgent`)) {
    return;
  }
  validateCreateAgent(declaration.createAgent, `${path}.createAgent`, issues);
}

function validateCreateAgent(create: JsonObject, path: string, issues: Issues): void {
  for (const field of ["title", "provider", "settings"]) {
    if (!(field in create)) {
      issues.add(`${path}.${field}`, "required");
    }
  }
  if (typeof create.title !== "string" || create.title.length === 0) {
    issues.add(`${path}.title`, "must be a non-empty string");
  }
  if (typeof create.provider !== "string" || create.provider.length === 0) {
    issues.add(`${path}.provider`, "must be a non-empty string");
  }
  if (create.model !== undefined && (typeof create.model !== "string" || !create.model)) {
    issues.add(`${path}.model`, "must be a non-empty string");
  }
  if (
    typeof create.provider === "string" &&
    create.provider.includes("/") &&
    create.model !== undefined
  ) {
    issues.add(path, "model conflicts with provider/model syntax");
  }
  if (!isObject(create.settings)) {
    issues.add(`${path}.settings`, "must be an object");
  }
}

function validatePrompts(value: unknown, issues: Issues): void {
  if (!issues.object(value, "prompts") || Object.keys(value).length === 0) {
    issues.add("prompts", "must be a non-empty object");
    return;
  }
  for (const [name, prompt] of Object.entries(value)) {
    if (typeof prompt !== "string") {
      issues.add(`prompts.${name}`, "must be a string");
      continue;
    }
    const opens = [...prompt.matchAll(/{%\s*if\b/g)].length;
    const closes = [...prompt.matchAll(/{%\s*endif\s*%}/g)].length;
    if (opens !== closes) {
      issues.add(`prompts.${name}`, "has an unbalanced if block");
    }
  }
}

function validateProtocol(value: unknown, issues: Issues): void {
  if (value === undefined) {
    return;
  }
  if (!issues.object(value, "protocol")) {
    return;
  }
  issues.unknown(value, "protocol", new Set(["maxAttempts"]));
  if (value.maxAttempts !== undefined && !isPositiveIntegerOrParameter(value.maxAttempts)) {
    issues.add("protocol.maxAttempts", "must be a positive integer");
  }
}

function validateLimits(value: unknown, issues: Issues): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!issues.object(value, "limits")) {
    return;
  }
  issues.unknown(value, "limits", new Set(["maxIterations", "maxRuntime"]));
  if (value.maxIterations !== undefined && !isPositiveIntegerOrParameter(value.maxIterations)) {
    issues.add("limits.maxIterations", "must be a positive integer");
  }
  if (
    value.maxRuntime !== undefined &&
    !DURATION.test(String(value.maxRuntime)) &&
    !isExactParameter(value.maxRuntime)
  ) {
    issues.add("limits.maxRuntime", "invalid duration");
  }
}

function validateFlows(
  value: unknown,
  entry: unknown,
  agents: ReadonlyMap<string, JsonObject>,
  prompts: unknown,
  issues: Issues,
): void {
  if (!issues.object(value, "flows") || Object.keys(value).length === 0) {
    issues.add("flows", "must be a non-empty object");
    return;
  }
  const flowNames = new Set(Object.keys(value));
  const promptNames = new Set(isObject(prompts) ? Object.keys(prompts) : []);
  if (typeof entry !== "string" || !flowNames.has(entry)) {
    issues.add("entry", "unknown flow");
  }
  for (const [flowName, flowValue] of Object.entries(value)) {
    const path = `flows.${flowName}`;
    if (!issues.object(flowValue, path)) {
      continue;
    }
    issues.unknown(flowValue, path, new Set(["initial", "states", "inputs"]));
    if (flowValue.inputs !== undefined && !isObject(flowValue.inputs)) {
      issues.add(`${path}.inputs`, "must be an object");
    }
    if (!issues.object(flowValue.states, `${path}.states`)) {
      continue;
    }
    const states = flowValue.states;
    const stateNames = new Set(Object.keys(states));
    if (typeof flowValue.initial !== "string" || !stateNames.has(flowValue.initial)) {
      issues.add(`${path}.initial`, "unknown state");
    }
    for (const [stateName, stateValue] of Object.entries(states)) {
      validateState(
        stateValue,
        `${path}.states.${stateName}`,
        stateNames,
        flowNames,
        agents,
        promptNames,
        issues,
      );
    }
  }
}

function validateState(
  value: unknown,
  path: string,
  stateNames: ReadonlySet<string>,
  flowNames: ReadonlySet<string>,
  agents: ReadonlyMap<string, JsonObject>,
  promptNames: ReadonlySet<string>,
  issues: Issues,
): void {
  if (!issues.object(value, path)) {
    return;
  }
  issues.unknown(value, path, new Set([...ACTIONS, "on"]));
  const actions = ACTIONS.filter((action) => action in value);
  if (actions.length !== 1) {
    issues.add(path, "must contain exactly one action");
    return;
  }
  const action = actions[0];
  const routes = validateRoutes(value.on, `${path}.on`, stateNames, action, issues);
  if (action === "turn") {
    const allowed = validateTurn(value.turn, path, agents, promptNames, routes, issues);
    validateAllowedRoutes(routes, allowed, path, issues);
  } else if (action === "call") {
    validateCall(value.call, `${path}.call`, flowNames, issues);
    if (!routes.has("returned")) {
      issues.add(`${path}.on.returned`, "required");
    }
    validateAllowedRoutes(routes, new Set([...RUNTIME_EVENTS, "returned"]), path, issues);
  } else if (action === "map") {
    validateMap(value.map, `${path}.map`, flowNames, issues);
    if (!routes.has("joined")) {
      issues.add(`${path}.on.joined`, "required");
    }
    validateAllowedRoutes(routes, new Set([...RUNTIME_EVENTS, "joined"]), path, issues);
  } else if (action === "return") {
    validateReturnState(value, path, issues);
  } else {
    validateStopState(value, path, issues);
  }
}

function validateTurn(
  value: unknown,
  path: string,
  agents: ReadonlyMap<string, JsonObject>,
  promptNames: ReadonlySet<string>,
  routes: ReadonlyMap<string, string>,
  issues: Issues,
): Set<string> {
  const allowed = new Set(RUNTIME_EVENTS);
  if (!issues.object(value, `${path}.turn`)) {
    return allowed;
  }
  issues.unknown(value, `${path}.turn`, new Set(["agent", "prompt", "emits"]));
  if (typeof value.agent !== "string" || !agents.has(value.agent)) {
    issues.add(`${path}.turn.agent`, "unknown agent");
  }
  if (typeof value.prompt !== "string" || !promptNames.has(value.prompt)) {
    issues.add(`${path}.turn.prompt`, "unknown prompt");
  }
  if (!issues.object(value.emits, `${path}.turn.emits`)) {
    return allowed;
  }
  for (const [event, declaration] of Object.entries(value.emits)) {
    validateEventDeclaration(event, declaration, path, routes, allowed, issues);
  }
  return allowed;
}

function validateEventDeclaration(
  event: string,
  value: unknown,
  path: string,
  routes: ReadonlyMap<string, string>,
  allowed: Set<string>,
  issues: Issues,
): void {
  const eventPath = `${path}.turn.emits.${event}`;
  if (RUNTIME_EVENTS.has(event)) {
    issues.add(eventPath, "reserved runtime event");
  }
  allowed.add(event);
  if (!issues.object(value, eventPath)) {
    return;
  }
  issues.unknown(value, eventPath, new Set(["description", "dataSchema"]));
  if (typeof value.description !== "string" || !value.description.trim()) {
    issues.add(`${eventPath}.description`, "must be a non-empty string");
  }
  if (value.dataSchema !== undefined) {
    try {
      new Ajv2020Constructor({ strict: true }).compile(value.dataSchema);
    } catch (error) {
      issues.add(`${eventPath}.dataSchema`, `invalid JSON Schema: ${errorMessage(error)}`);
    }
  }
  if (!routes.has(event)) {
    issues.add(`${path}.on.${event}`, "required for emitted event");
  }
}

function validateAllowedRoutes(
  routes: ReadonlyMap<string, string>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: Issues,
): void {
  for (const event of routes.keys()) {
    if (!allowed.has(event)) {
      issues.add(`${path}.on.${event}`, "unsupported event");
    }
  }
}

function validateReturnState(value: JsonObject, path: string, issues: Issues): void {
  if (value.on !== undefined) {
    issues.add(`${path}.on`, "not allowed for return state");
  }
  if (!issues.object(value.return, `${path}.return`) || !("output" in value.return)) {
    issues.add(`${path}.return.output`, "required");
  }
}

function validateStopState(value: JsonObject, path: string, issues: Issues): void {
  if (value.on !== undefined) {
    issues.add(`${path}.on`, "not allowed for stop state");
  }
  if (
    !issues.object(value.stop, `${path}.stop`) ||
    typeof value.stop.reason !== "string" ||
    !value.stop.reason.trim()
  ) {
    issues.add(`${path}.stop.reason`, "must be a non-empty string");
  }
}

function validateRoutes(
  value: unknown,
  path: string,
  stateNames: ReadonlySet<string>,
  action: (typeof ACTIONS)[number],
  issues: Issues,
): Map<string, string> {
  const result = new Map<string, string>();
  if ((action === "turn" || action === "call" || action === "map") && value === undefined) {
    issues.add(path, "required");
    return result;
  }
  if (value === undefined) {
    return result;
  }
  if (!issues.object(value, path)) {
    return result;
  }
  for (const [event, target] of Object.entries(value)) {
    if (typeof target !== "string" || !stateNames.has(target)) {
      issues.add(`${path}.${event}`, "unknown state");
    } else {
      result.set(event, target);
    }
  }
  return result;
}

function validateCall(
  value: unknown,
  path: string,
  flowNames: ReadonlySet<string>,
  issues: Issues,
): void {
  if (!issues.object(value, path)) {
    return;
  }
  issues.unknown(value, path, new Set(["flow", "with", "workspace"]));
  if (typeof value.flow !== "string" || !flowNames.has(value.flow)) {
    issues.add(`${path}.flow`, "unknown flow");
  }
  if (value.with !== undefined && !isObject(value.with)) {
    issues.add(`${path}.with`, "must be an object");
  }
  if (value.workspace !== undefined) {
    if (!issues.object(value.workspace, `${path}.workspace`)) {
      return;
    }
    const keys = Object.keys(value.workspace);
    if (keys.length !== 1 || !["inherit", "createWorktree"].includes(keys[0])) {
      issues.add(`${path}.workspace`, "must contain exactly one of createWorktree or inherit");
    } else if (keys[0] === "inherit" && value.workspace.inherit !== true) {
      issues.add(`${path}.workspace.inherit`, "must be true");
    } else if (keys[0] === "createWorktree") {
      validateWorkspace(value.workspace, `${path}.workspace`, issues);
    }
  }
}

function validateMap(
  value: unknown,
  path: string,
  flowNames: ReadonlySet<string>,
  issues: Issues,
): void {
  if (!issues.object(value, path)) {
    return;
  }
  issues.unknown(value, path, new Set(["group", "items", "as", "call", "join", "concurrency"]));
  if (typeof value.group !== "string" || !value.group.trim()) {
    issues.add(`${path}.group`, "must be a non-empty string");
  }
  if (typeof value.items !== "string" || !value.items.trim()) {
    issues.add(`${path}.items`, "must be a non-empty string");
  }
  if (typeof value.as !== "string" || !IDENTIFIER.test(value.as)) {
    issues.add(`${path}.as`, "must be an identifier");
  }
  validateCall(value.call, `${path}.call`, flowNames, issues);
  if (value.join !== "all") {
    issues.add(`${path}.join`, "must be all");
  }
  if (value.concurrency !== undefined && !isPositiveIntegerOrParameter(value.concurrency)) {
    issues.add(`${path}.concurrency`, "must be a positive integer");
  }
}

export function materializeWorkflowSpec(
  template: unknown,
  values: JsonObject = {},
  context: WorkflowCallerContext = {},
): MaterializedWorkflow {
  const validation = validateWorkflowTemplate(template);
  if (!validation.valid || !isObject(template)) {
    throw new Error(formatValidationIssues(validation.issues));
  }
  const declarations = isObject(template.parameters) ? template.parameters : {};
  for (const name of Object.keys(values)) {
    if (!(name in declarations)) {
      throw new Error(`parameters.${name}: unknown parameter`);
    }
  }
  const resolved: JsonObject = {};
  for (const [name, rawDeclaration] of Object.entries(declarations)) {
    if (!isObject(rawDeclaration)) {
      continue;
    }
    let value: unknown;
    if (name in values) {
      value = values[name];
    } else if ("default" in rawDeclaration) {
      value = rawDeclaration.default;
    } else if (typeof rawDeclaration.defaultFrom === "string") {
      value = resolveDefault(rawDeclaration.defaultFrom, context);
      if (value === undefined && rawDeclaration.required === true) {
        throw new Error(
          `defaultFrom: ${rawDeclaration.defaultFrom} requires an agent or workspace context`,
        );
      }
    } else if (rawDeclaration.required === true) {
      throw new Error(`parameters.${name}: required`);
    } else {
      value = null;
    }
    resolved[name] = coerceParameter(name, rawDeclaration, value);
  }
  const materialized = renderParameterTree(
    Object.fromEntries(Object.entries(template).filter(([key]) => key !== "parameters")),
    resolved,
  );
  if (!isObject(materialized)) {
    throw new Error("$: materialized spec must be an object");
  }
  const materializedValidation = validateWorkflowTemplate(materialized);
  if (!materializedValidation.valid) {
    throw new Error(formatValidationIssues(materializedValidation.issues));
  }
  return { spec: materialized, canonicalJson: canonicalJson(materialized) };
}

function resolveDefault(source: string, context: WorkflowCallerContext): string | undefined {
  if (source === "current.workspace") return context.workspaceId;
  if (source === "current.worktree") return context.worktreePath;
  if (source === "current.agent") return context.agentId;
  return undefined;
}

function coerceParameter(name: string, declaration: JsonObject, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  const type = parameterType(declaration);
  const path = `parameters.${name}`;
  if (["string", "path", "image"].includes(type)) {
    if (typeof value !== "string") throw new Error(`${path}: must be a string`);
    return value;
  }
  if (type === "object") {
    if (!isObject(value)) throw new Error(`${path}: must be an object`);
    return value;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path}: must be an array`);
    return value;
  }
  if (type === "enum") {
    if (!Array.isArray(declaration.values) || !declaration.values.includes(value)) {
      throw new Error(`${path}: must be one of ${JSON.stringify(declaration.values)}`);
    }
    return value;
  }
  if (type === "boolean") return coerceBoolean(path, value);
  if (type === "integer" || type === "number") {
    return coerceNumber(path, value, type === "integer");
  }
  throw new Error(`${path}.type: invalid parameter type`);
}

function coerceBoolean(path: string, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && ["true", "false"].includes(value.toLowerCase())) {
    return value.toLowerCase() === "true";
  }
  throw new Error(`${path}: must be a boolean`);
}

function coerceNumber(path: string, value: unknown, integer: boolean): number {
  const label = integer ? "integer" : "number";
  if (typeof value === "boolean") throw new Error(`${path}: must be a ${label}`);
  const number = typeof value === "string" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isFinite(number) ||
    (integer && !Number.isInteger(number))
  ) {
    throw new Error(`${path}: must be a ${label}`);
  }
  return number;
}

function renderParameterTree(value: unknown, parameters: JsonObject): unknown {
  if (typeof value === "string") {
    const exact = value.match(EXACT_PARAMETER);
    if (exact) {
      return parameters[exact[1]];
    }
    return value.replace(INLINE_PARAMETER, (_, name: string) =>
      stringifyParameter(parameters[name]),
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderParameterTree(item, parameters));
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderParameterTree(item, parameters)]),
    );
  }
  return value;
}

function stringifyParameter(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return canonicalJson(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export function formatValidationIssues(issues: readonly WorkflowValidationIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

function parameterType(
  declaration: JsonObject,
): WorkflowValidationResult["parameters"][number]["type"] {
  return (
    typeof declaration.type === "string" ? declaration.type : "string"
  ) as WorkflowValidationResult["parameters"][number]["type"];
}

function stripTemplates(value: string): string {
  return value.replace(/{{.*?}}|{%.*?%}/g, "");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPositiveIntegerOrParameter(value: unknown): boolean {
  return isPositiveInteger(value) || isExactParameter(value);
}

function isExactParameter(value: unknown): boolean {
  return typeof value === "string" && EXACT_PARAMETER.test(value);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
