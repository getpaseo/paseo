import { readFile } from "node:fs/promises";
import type { WorkflowRunSummary, WorkflowSpecSummary } from "@getpaseo/protocol/workflow/types";
import { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { withOutput } from "../../output/index.js";
import type { CommandOptions, ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";

interface WorkflowOptions extends CommandOptions {
  host?: string;
}

interface WorkflowRunOptions extends WorkflowOptions {
  params?: string;
  paramsFile?: string;
  workspace?: string;
  agent?: string;
}

interface InspectRow {
  id: string;
  status: string;
  workflow: string;
  updatedAt: string;
  reason: string | null;
}

const specSchema: OutputSchema<WorkflowSpecSummary> = {
  idField: "id",
  columns: [
    { header: "WORKFLOW", field: "id", width: 24 },
    { header: "SOURCE", field: "source", width: 10 },
    { header: "VERSION", field: "version", width: 10 },
    { header: "DESCRIPTION", field: "description", width: 60 },
  ],
};

const runSchema: OutputSchema<WorkflowRunSummary> = {
  idField: "id",
  columns: [
    { header: "RUN ID", field: "id", width: 28 },
    { header: "WORKFLOW", field: "workflowId", width: 22 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "ITER", field: "iteration", width: 6 },
    { header: "ACTIVE", field: "activeTurns", width: 7 },
    { header: "UPDATED", field: "updatedAt", width: 24 },
  ],
};

export function createWorkflowCommand(): Command {
  const workflow = new Command("workflow").description(
    "Create, validate, run, and inspect native workflows",
  );

  addJsonAndDaemonHostOptions(workflow.command("specs").description("List workflow definitions"))
    .alias("ls")
    .action(withOutput(listSpecs));
  addJsonAndDaemonHostOptions(
    workflow.command("show").description("Show a workflow definition").argument("<id>"),
  ).action(withOutput(showSpec));
  addJsonAndDaemonHostOptions(
    workflow
      .command("validate")
      .description("Validate a JSON workflow definition")
      .argument("<file>"),
  ).action(withOutput(validateSpec));
  addJsonAndDaemonHostOptions(
    workflow
      .command("import")
      .description("Validate and save a JSON workflow definition")
      .argument("<file>"),
  ).action(withOutput(importSpec));
  addJsonAndDaemonHostOptions(
    workflow
      .command("run")
      .description("Queue a workflow and print its run ID")
      .argument("<id>")
      .option("--params <json>", "Workflow parameters as a JSON object")
      .option("--params-file <file>", "Read workflow parameters from a JSON file")
      .option("--workspace <workspace-id>", "Bind current.workspace")
      .option("--agent <agent-id>", "Bind current.agent and its native workspace"),
  ).action(withOutput(runWorkflow));
  addJsonAndDaemonHostOptions(workflow.command("runs").description("List workflow runs")).action(
    withOutput(listRuns),
  );
  addJsonAndDaemonHostOptions(
    workflow.command("inspect").description("Inspect workflow audit data").argument("<run-id>"),
  ).action(withOutput(inspectRun));
  addJsonAndDaemonHostOptions(
    workflow.command("logs").description("Read workflow events").argument("<run-id>"),
  ).action(withOutput(readLogs));
  addJsonAndDaemonHostOptions(
    workflow.command("stop").description("Request a graceful stop").argument("<run-id>"),
  ).action(withOutput(stopRun));
  addJsonAndDaemonHostOptions(
    workflow.command("resume").description("Resume a stopped workflow").argument("<run-id>"),
  ).action(withOutput(resumeRun));

  return workflow;
}

async function listSpecs(
  options: WorkflowOptions,
  _command: Command,
): Promise<ListResult<WorkflowSpecSummary>> {
  return withClient(options, async (client) => {
    const payload = requirePayload(await client.workflowSpecList());
    return { type: "list", data: payload.specs, schema: specSchema };
  });
}

async function showSpec(
  id: string,
  options: WorkflowOptions,
  _command: Command,
): Promise<SingleResult<Record<string, unknown>>> {
  return withClient(options, async (client) => {
    const payload = requirePayload(await client.workflowSpecGet(id));
    if (!payload.spec) throw new Error(`workflow spec not found: ${id}`);
    return { type: "single", data: payload.spec, schema: jsonObjectSchema(id) };
  });
}

async function validateSpec(
  file: string,
  options: WorkflowOptions,
  _command: Command,
): Promise<SingleResult<Record<string, unknown>>> {
  const spec = await readJsonObject(file);
  return withClient(options, async (client) => {
    const payload = requirePayload(await client.workflowSpecValidate(spec));
    return {
      type: "single",
      data: payload.validation,
      schema: jsonObjectSchema("validation"),
    };
  });
}

async function importSpec(
  file: string,
  options: WorkflowOptions,
  _command: Command,
): Promise<SingleResult<Record<string, unknown>>> {
  const spec = await readJsonObject(file);
  return withClient(options, async (client) => {
    const payload = requirePayload(await client.workflowSpecSave(spec));
    if (!payload.spec) throw new Error("daemon did not return the saved workflow");
    return { type: "single", data: payload.spec, schema: jsonObjectSchema("workflow") };
  });
}

async function runWorkflow(
  id: string,
  options: WorkflowRunOptions,
  _command: Command,
): Promise<SingleResult<WorkflowRunSummary>> {
  const parameters = await parseParameters(options);
  return withClient(options, async (client) => {
    const payload = requirePayload(
      await client.workflowRunStart({
        workflowId: id,
        parameters,
        context:
          options.workspace || options.agent
            ? { workspaceId: options.workspace, agentId: options.agent }
            : undefined,
      }),
    );
    if (!payload.run) throw new Error("daemon did not return the queued workflow run");
    return { type: "single", data: payload.run, schema: runSchema };
  });
}

async function listRuns(
  options: WorkflowOptions,
  _command: Command,
): Promise<ListResult<WorkflowRunSummary>> {
  return withClient(options, async (client) => {
    const payload = requirePayload(await client.workflowRunList());
    return { type: "list", data: payload.runs, schema: runSchema };
  });
}

async function inspectRun(
  runId: string,
  options: WorkflowOptions,
  _command: Command,
): Promise<SingleResult<InspectRow>> {
  return withClient(options, async (client) => {
    const payload = requirePayload(await client.workflowRunInspect(runId));
    if (!payload.details) throw new Error(`workflow run not found: ${runId}`);
    const row = toInspectRow(payload.details.run);
    return {
      type: "single",
      data: row,
      schema: { ...inspectSchema, serialize: () => payload.details },
    };
  });
}

async function readLogs(
  runId: string,
  options: WorkflowOptions,
  _command: Command,
): Promise<ListResult<Record<string, unknown>>> {
  return withClient(options, async (client) => {
    const payload = requirePayload(await client.workflowRunLogs({ runId }));
    return {
      type: "list",
      data: payload.entries,
      schema: eventSchema,
    };
  });
}

async function stopRun(
  runId: string,
  options: WorkflowOptions,
  _command: Command,
): Promise<SingleResult<WorkflowRunSummary>> {
  return mutateRun(options, (client) => client.workflowRunStop(runId));
}

async function resumeRun(
  runId: string,
  options: WorkflowOptions,
  _command: Command,
): Promise<SingleResult<WorkflowRunSummary>> {
  return mutateRun(options, (client) => client.workflowRunResume(runId));
}

async function mutateRun(
  options: WorkflowOptions,
  operation: (client: DaemonClient) => ReturnType<DaemonClient["workflowRunStop"]>,
): Promise<SingleResult<WorkflowRunSummary>> {
  return withClient(options, async (client) => {
    const payload = requirePayload(await operation(client));
    if (!payload.run) throw new Error("daemon did not return the workflow run");
    return { type: "single", data: payload.run, schema: runSchema };
  });
}

async function withClient<T>(
  options: WorkflowOptions,
  operation: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = await connectToDaemon({ host: options.host });
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

function requirePayload<T extends { error: string | null }>(payload: T): T {
  if (payload.error) throw new Error(payload.error);
  return payload;
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file} must contain one JSON object`);
  }
  return value as Record<string, unknown>;
}

async function parseParameters(options: WorkflowRunOptions): Promise<Record<string, unknown>> {
  if (options.params && options.paramsFile) {
    throw new Error("use either --params or --params-file");
  }
  if (options.paramsFile) return readJsonObject(options.paramsFile);
  if (!options.params) return {};
  const value = JSON.parse(options.params) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--params must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function toInspectRow(run: WorkflowRunSummary): InspectRow {
  return {
    id: run.id,
    status: run.status,
    workflow: run.workflowId,
    updatedAt: run.updatedAt,
    reason: run.reason,
  };
}

const inspectSchema: OutputSchema<InspectRow> = {
  idField: "id",
  columns: [
    { header: "RUN ID", field: "id", width: 28 },
    { header: "WORKFLOW", field: "workflow", width: 20 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "REASON", field: (row) => row.reason ?? "-", width: 20 },
    { header: "UPDATED", field: "updatedAt", width: 24 },
  ],
};

const eventSchema: OutputSchema<Record<string, unknown>> = {
  idField: (event) => String(event.seq ?? ""),
  columns: [
    { header: "SEQ", field: (event) => event.seq, width: 6 },
    { header: "TIME", field: (event) => event.timestamp, width: 24 },
    { header: "TYPE", field: (event) => event.type, width: 24 },
    { header: "EVENT", field: (event) => event.event ?? "", width: 18 },
    { header: "MESSAGE", field: (event) => event.message ?? "", width: 60 },
  ],
};

function jsonObjectSchema(id: string): OutputSchema<Record<string, unknown>> {
  return {
    idField: () => id,
    columns: [
      { header: "FIELD", field: () => id, width: 20 },
      { header: "JSON", field: (value) => JSON.stringify(value), width: 100 },
    ],
  };
}
