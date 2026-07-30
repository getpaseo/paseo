import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  WorkflowEventRecord,
  WorkflowRenderedPrompt,
  WorkflowRunDetails,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowSpecSummary,
} from "@getpaseo/protocol/workflow/types";
import { parse as parseYaml } from "yaml";
import { writeFileAtomic, writeJsonFileAtomic } from "../atomic-file.js";
import { canonicalJson, type JsonObject, validateWorkflowTemplate } from "./spec.js";

const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]*$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface WorkflowStorageOptions {
  paseoHome: string;
  builtInDirectory: string;
}

export class WorkflowStorage {
  readonly root: string;
  readonly userSpecRoot: string;
  readonly runRoot: string;
  readonly legacyRunRoot: string;
  private readonly builtInDirectory: string;

  constructor(options: WorkflowStorageOptions) {
    this.root = path.join(options.paseoHome, "workflows");
    this.userSpecRoot = path.join(this.root, "specs");
    this.runRoot = path.join(this.root, "runs");
    this.legacyRunRoot = path.join(options.paseoHome, "workflow-runs");
    this.builtInDirectory = options.builtInDirectory;
  }

  async initialize(): Promise<void> {
    await this.ensureDirectory(this.root);
    await this.ensureDirectory(this.userSpecRoot);
    await this.ensureDirectory(this.runRoot);
  }

  async listSpecs(): Promise<WorkflowSpecSummary[]> {
    const results = new Map<string, WorkflowSpecSummary>();
    for (const [source, directory] of [
      ["user", this.userSpecRoot],
      ["built-in", this.builtInDirectory],
    ] as const) {
      for (const file of await listJsonFiles(directory)) {
        const spec = await readJsonObject(path.join(directory, file), "workflow spec");
        const validation = validateWorkflowTemplate(spec, source);
        if (!validation.valid || !validation.summary) {
          continue;
        }
        const stat = source === "user" ? await fs.stat(path.join(directory, file)) : null;
        results.set(validation.summary.id, {
          ...validation.summary,
          updatedAt: stat?.mtime.toISOString() ?? null,
        });
      }
    }
    return [...results.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async getSpec(id: string): Promise<JsonObject> {
    assertWorkflowId(id);
    const builtInPath = path.join(this.builtInDirectory, `${id}.json`);
    if (await exists(builtInPath)) {
      await assertNotSymlink(builtInPath);
      return readJsonObject(builtInPath, "workflow spec");
    }
    const userPath = path.join(this.userSpecRoot, `${id}.json`);
    if (await exists(userPath)) {
      await assertNotSymlink(userPath);
      return readJsonObject(userPath, "workflow spec");
    }
    throw new Error(`workflow spec not found: ${id}`);
  }

  async saveUserSpec(value: unknown): Promise<JsonObject> {
    const validation = validateWorkflowTemplate(value, "user");
    if (!validation.valid || !validation.summary || !isObject(value)) {
      const message = validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n");
      throw new Error(message || "invalid workflow spec");
    }
    const id = validation.summary.id;
    assertWorkflowId(id);
    const builtInPath = path.join(this.builtInDirectory, `${id}.json`);
    if (await exists(builtInPath)) {
      throw new Error(`built-in workflow specs cannot be replaced: ${id}`);
    }
    await this.ensureDirectory(this.userSpecRoot);
    const filePath = path.join(this.userSpecRoot, `${id}.json`);
    if (await exists(filePath)) {
      await assertNotSymlink(filePath);
    }
    await writeFileAtomic(
      filePath,
      `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`,
    );
    return value;
  }

  async createRun(runId: string, spec: JsonObject, state: JsonObject): Promise<void> {
    assertRunId(runId);
    await this.ensureDirectory(this.runRoot);
    const runDirectory = path.join(this.runRoot, runId);
    try {
      await fs.mkdir(runDirectory);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(`workflow run already exists: ${runId}`, { cause: error });
      }
      throw error;
    }
    await fs.mkdir(path.join(runDirectory, "rendered-prompts"));
    await fs.mkdir(path.join(runDirectory, "event-history"));
    await writeFileAtomic(
      path.join(runDirectory, "spec.json"),
      `${JSON.stringify(spec, null, 2)}\n`,
    );
    await writeJsonFileAtomic(path.join(runDirectory, "state.json"), state);
    await writeFileAtomic(path.join(runDirectory, "events.jsonl"), "");
  }

  async readState(runId: string): Promise<JsonObject> {
    const { directory } = await this.resolveRun(runId);
    try {
      return await readJsonObject(path.join(directory, "state.json"), "workflow state");
    } catch (error) {
      throw new Error(`corrupt workflow state for ${runId}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  async saveState(runId: string, state: JsonObject): Promise<void> {
    const { directory, legacy } = await this.resolveRun(runId);
    if (legacy) {
      throw new Error(`legacy workflow state is read-only: ${runId}`);
    }
    await writeJsonFileAtomic(path.join(directory, "state.json"), state);
  }

  async appendEvent(runId: string, event: WorkflowEventRecord): Promise<void> {
    const { directory, legacy } = await this.resolveRun(runId);
    if (legacy) {
      throw new Error(`legacy workflow audit is read-only: ${runId}`);
    }
    const handle = await fs.open(path.join(directory, "events.jsonl"), "a");
    try {
      await handle.write(`${canonicalJson(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async writePrompt(
    runId: string,
    prompt: Omit<WorkflowRenderedPrompt, "content"> & { content: string },
  ): Promise<string> {
    const { directory, legacy } = await this.resolveRun(runId);
    if (legacy) {
      throw new Error(`legacy workflow prompts are read-only: ${runId}`);
    }
    const name = safePromptName(prompt.name);
    await writeFileAtomic(path.join(directory, "rendered-prompts", name), prompt.content);
    return name;
  }

  async writeAcceptedEvent(
    runId: string,
    workflowTurnId: string,
    event: {
      event: string;
      message: string;
      data: unknown;
      acceptedAt: string;
      nativeTurnId: string;
    },
  ): Promise<void> {
    const { directory, legacy } = await this.resolveRun(runId);
    if (legacy) {
      throw new Error(`legacy workflow event history is read-only: ${runId}`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(workflowTurnId)) {
      throw new Error(`invalid workflow turn id: ${workflowTurnId}`);
    }
    const filePath = path.join(directory, "event-history", `${workflowTurnId}.json`);
    if (await exists(filePath)) {
      throw new Error(`workflow event was already accepted: ${workflowTurnId}`);
    }
    await writeJsonFileAtomic(filePath, event);
  }

  async inspectRun(runId: string): Promise<WorkflowRunDetails> {
    const resolved = await this.resolveRun(runId);
    const state = await this.readState(runId);
    const spec = await this.readRunSpec(resolved);
    const events = await readEvents(path.join(resolved.directory, "events.jsonl"));
    const prompts = await readPrompts(path.join(resolved.directory, "rendered-prompts"), state);
    return {
      run: summarizeRun(runId, state, resolved.legacy),
      state,
      spec,
      events,
      prompts,
    };
  }

  async listRuns(): Promise<WorkflowRunSummary[]> {
    const rows: WorkflowRunSummary[] = [];
    for (const [directory, legacy] of [
      [this.runRoot, false],
      [this.legacyRunRoot, true],
    ] as const) {
      for (const runId of await listDirectories(directory)) {
        if (!RUN_ID.test(runId)) {
          continue;
        }
        try {
          const resolved = await this.resolveRun(runId);
          if (resolved.legacy !== legacy) {
            continue;
          }
          const state = await this.readState(runId);
          rows.push(summarizeRun(runId, state, legacy));
        } catch {
          continue;
        }
      }
    }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async readRunSpec(resolved: ResolvedRun): Promise<JsonObject> {
    const jsonPath = path.join(resolved.directory, "spec.json");
    if (await exists(jsonPath)) {
      await assertNotSymlink(jsonPath);
      return readJsonObject(jsonPath, "materialized workflow spec");
    }
    const yamlPath = path.join(resolved.directory, "spec.yaml");
    await assertNotSymlink(yamlPath);
    const text = await fs.readFile(yamlPath, "utf8");
    const value = parseYaml(text);
    if (!isObject(value)) {
      throw new Error(`legacy workflow spec is not an object: ${resolved.directory}`);
    }
    return value;
  }

  private async resolveRun(runId: string): Promise<ResolvedRun> {
    assertRunId(runId);
    const native = path.join(this.runRoot, runId);
    if (await exists(native)) {
      await assertDirectoryNotSymlink(native);
      return { directory: native, legacy: false };
    }
    const legacy = path.join(this.legacyRunRoot, runId);
    if (await exists(legacy)) {
      await assertDirectoryNotSymlink(legacy);
      return { directory: legacy, legacy: true };
    }
    throw new Error(`workflow run not found: ${runId}`);
  }

  private async ensureDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true });
    await assertDirectoryNotSymlink(directory);
  }
}

interface ResolvedRun {
  directory: string;
  legacy: boolean;
}

function summarizeRun(runId: string, state: JsonObject, legacy: boolean): WorkflowRunSummary {
  const status = normalizeStatus(state.status);
  const instances = isObject(state.instances) ? Object.values(state.instances) : [];
  const activeTurns = instances.filter(
    (instance) => isObject(instance) && isObject(instance.activeTurn),
  ).length;
  const agentIds = new Set<string>();
  const workspaceIds = new Set<string>();
  collectIdentities(state, "agentId", agentIds);
  collectIdentities(state, "workspaceId", workspaceIds);
  const workflow = isObject(state.workflow) ? state.workflow : {};
  const loop = isObject(state.loop) ? state.loop : {};
  const now = new Date(0).toISOString();
  const schemaVersion = state.schemaVersion;
  const workflowId = firstString(workflow.id, workflow.name) ?? "legacy";
  const workflowName = firstString(workflow.name, workflow.id) ?? "Legacy workflow";
  const reason = firstString(state.reason, state.stopReason);
  return {
    id: runId,
    workflowId,
    workflowName,
    status,
    reason,
    createdAt: stringOr(state.createdAt, now),
    updatedAt: stringOr(state.updatedAt, stringOr(state.completedAt, now)),
    startedAt: nullableString(state.startedAt),
    completedAt: nullableString(state.completedAt),
    iteration: typeof loop.iteration === "number" ? loop.iteration : 0,
    activeTurns,
    legacy,
    resumable:
      status === "stopped" &&
      schemaVersion === "paseo.workflows.run.v0.2" &&
      isObject(state.instances),
    workspaceIds: [...workspaceIds],
    agentIds: [...agentIds],
  };
}

function collectIdentities(value: unknown, key: string, result: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectIdentities(item, key, result);
    return;
  }
  if (!isObject(value)) return;
  for (const [name, item] of Object.entries(value)) {
    if (name === key && typeof item === "string" && item) result.add(item);
    else collectIdentities(item, key, result);
  }
}

async function readEvents(filePath: string): Promise<WorkflowEventRecord[]> {
  if (!(await exists(filePath))) return [];
  await assertNotSymlink(filePath);
  const text = await fs.readFile(filePath, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line, index) => normalizeEvent(JSON.parse(line) as unknown, index + 1));
}

function normalizeEvent(value: unknown, seq: number): WorkflowEventRecord {
  if (!isObject(value)) {
    return {
      seq,
      timestamp: new Date(0).toISOString(),
      type: "invalid_legacy_event",
      details: { value },
    };
  }
  const known = new Set([
    "seq",
    "timestamp",
    "type",
    "instanceId",
    "flow",
    "state",
    "agent",
    "agentId",
    "event",
    "message",
    "data",
    "details",
  ]);
  const legacyDetails = Object.fromEntries(
    Object.entries(value).filter(([key]) => !known.has(key)),
  );
  const details = {
    ...(isObject(value.details) ? value.details : {}),
    ...legacyDetails,
  };
  return {
    seq: typeof value.seq === "number" ? value.seq : seq,
    timestamp: stringOr(value.timestamp, new Date(0).toISOString()),
    type: stringOr(value.type, "legacy_event"),
    ...(typeof value.instanceId === "string" ? { instanceId: value.instanceId } : {}),
    ...(typeof value.flow === "string" ? { flow: value.flow } : {}),
    ...(typeof value.state === "string" ? { state: value.state } : {}),
    ...(typeof value.agent === "string" ? { agent: value.agent } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.event === "string" ? { event: value.event } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...("data" in value ? { data: value.data } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

async function readPrompts(
  directory: string,
  state: JsonObject,
): Promise<WorkflowRenderedPrompt[]> {
  if (!(await exists(directory))) return [];
  await assertDirectoryNotSymlink(directory);
  const identities = promptIdentities(state);
  const prompts: WorkflowRenderedPrompt[] = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    if (!name.endsWith(".txt")) continue;
    const filePath = path.join(directory, name);
    await assertNotSymlink(filePath);
    const identity = identities.get(name);
    prompts.push({
      name,
      workflowTurnId: identity?.workflowTurnId ?? null,
      instanceId: identity?.instanceId ?? null,
      agentId: identity?.agentId ?? null,
      createdAt: identity?.createdAt ?? null,
      content: await fs.readFile(filePath, "utf8"),
    });
  }
  return prompts;
}

function promptIdentities(
  state: JsonObject,
): Map<string, Omit<WorkflowRenderedPrompt, "name" | "content">> {
  const result = new Map<string, Omit<WorkflowRenderedPrompt, "name" | "content">>();
  collectPromptIdentities(state, result);
  return result;
}

function collectPromptIdentities(
  value: unknown,
  result: Map<string, Omit<WorkflowRenderedPrompt, "name" | "content">>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPromptIdentities(item, result);
    return;
  }
  if (!isObject(value)) return;
  if (typeof value.promptPath === "string") {
    const name = path.basename(value.promptPath);
    result.set(name, {
      workflowTurnId: nullableString(value.workflowTurnId),
      instanceId: nullableString(value.instanceId),
      agentId: nullableString(value.agentId),
      createdAt: nullableString(value.createdAt),
    });
  }
  for (const item of Object.values(value)) collectPromptIdentities(item, result);
}

async function readJsonObject(filePath: string, label: string): Promise<JsonObject> {
  await assertNotSymlink(filePath);
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

async function listJsonFiles(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  await assertDirectoryNotSymlink(directory);
  return (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
}

async function listDirectories(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  await assertDirectoryNotSymlink(directory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
}

async function assertDirectoryNotSymlink(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${directory}`);
  if (!stat.isDirectory()) throw new Error(`expected directory: ${directory}`);
}

async function assertNotSymlink(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${filePath}`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertWorkflowId(id: string): void {
  if (!WORKFLOW_ID.test(id)) throw new Error(`invalid workflow id: ${id}`);
}

function assertRunId(id: string): void {
  if (!RUN_ID.test(id)) throw new Error(`invalid workflow run id: ${id}`);
}

function safePromptName(name: string): string {
  const basename = path.basename(name);
  if (basename !== name || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.txt$/.test(name)) {
    throw new Error(`invalid rendered prompt name: ${name}`);
  }
  return name;
}

function normalizeStatus(value: unknown): WorkflowRunStatus {
  if (value === "succeeded") return "complete";
  if (["queued", "running", "stopping", "stopped", "complete", "failed"].includes(String(value))) {
    return value as WorkflowRunStatus;
  }
  return "failed";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
