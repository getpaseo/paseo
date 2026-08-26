import type { WatchdogJob } from "@getpaseo/protocol/watchdog/types";
import { Command } from "commander";

import type {
  CommandError,
  CommandOptions,
  ListResult,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { parseDuration } from "../../utils/duration.js";

interface WatchdogOptions extends CommandOptions {
  host?: string;
  agent?: string;
  workspace?: string;
  cwd?: string;
  name?: string;
  timeout?: string;
}

type ConnectedClient = Awaited<ReturnType<typeof connectToDaemon>>;

interface WatchdogRow {
  id: string;
  name: string;
  status: string;
  delivery: string;
  agent: string;
  exitCode: number | null;
  updatedAt: string;
}

const watchdogSchema: OutputSchema<WatchdogRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 12 },
    { header: "NAME", field: "name", width: 24 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "DELIVERY", field: "delivery", width: 10 },
    { header: "AGENT", field: "agent", width: 12 },
    { header: "EXIT", field: "exitCode", width: 6 },
    { header: "UPDATED", field: "updatedAt", width: 24 },
  ],
};

export function createWatchdogCommand(): Command {
  const watchdog = new Command("watchdog").description("Manage durable background commands");

  addJsonAndDaemonHostOptions(
    watchdog
      .command("start")
      .description("Start a durable background command")
      .argument("<command>", "Executable to run directly (without a shell)")
      .argument("[args...]", "Arguments passed to the executable")
      .option("--name <name>", "Human-readable job name")
      .option("--agent <id>", "Agent to notify (defaults to PASEO_AGENT_ID)")
      .option("--workspace <id>", "Workspace owner (defaults to PASEO_WORKSPACE_ID)")
      .option("--cwd <path>", "Working directory (defaults to current directory locally)")
      .option("--timeout <duration>", "Terminate after a duration such as 30m or 2h"),
  ).action(withOutput(runStart));

  addJsonAndDaemonHostOptions(
    watchdog
      .command("ls")
      .description("List durable background commands")
      .option("--agent <id>", "Filter by agent id"),
  ).action(withOutput(runList));

  addJsonAndDaemonHostOptions(
    watchdog.command("inspect").description("Inspect a durable command").argument("<id>", "Job ID"),
  ).action(withOutput(runInspect));

  addJsonAndDaemonHostOptions(
    watchdog.command("cancel").description("Cancel a durable command").argument("<id>", "Job ID"),
  ).action(withOutput(runCancel));

  return watchdog;
}

async function runStart(
  executable: string,
  args: string[],
  options: WatchdogOptions,
  _command: Command,
): Promise<SingleResult<WatchdogRow>> {
  const { agentId, workspaceId, cwd } = resolveStartTarget(options);
  const timeoutMs = options.timeout ? parseDuration(options.timeout) : undefined;
  const client = await connect(options.host);
  try {
    const payload = await client.watchdogStart({
      name: options.name?.trim() || executable,
      agentId,
      workspaceId,
      cwd,
      command: executable,
      args,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    if (payload.error || !payload.job) throw new Error(payload.error ?? "Watchdog start failed");
    return single(payload.job);
  } finally {
    await client.close().catch(() => {});
  }
}

async function runList(
  options: WatchdogOptions,
  _command: Command,
): Promise<ListResult<WatchdogRow>> {
  const client = await connect(options.host);
  try {
    const agentId = options.agent?.trim();
    const payload = await client.watchdogList(agentId ? { agentId } : {});
    if (payload.error) throw new Error(payload.error);
    return { type: "list", data: payload.jobs.map(toRow), schema: watchdogSchema };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runInspect(
  id: string,
  options: WatchdogOptions,
  _command: Command,
): Promise<SingleResult<WatchdogRow>> {
  const client = await connect(options.host);
  try {
    const payload = await client.watchdogInspect({ id });
    if (payload.error || !payload.job)
      throw new Error(payload.error ?? `Watchdog not found: ${id}`);
    return single(payload.job);
  } finally {
    await client.close().catch(() => {});
  }
}

async function runCancel(
  id: string,
  options: WatchdogOptions,
  _command: Command,
): Promise<SingleResult<WatchdogRow>> {
  const client = await connect(options.host);
  try {
    const payload = await client.watchdogCancel({ id });
    if (payload.error || !payload.job)
      throw new Error(payload.error ?? `Watchdog not found: ${id}`);
    return single(payload.job);
  } finally {
    await client.close().catch(() => {});
  }
}

async function connect(host: string | undefined): Promise<ConnectedClient> {
  try {
    const client = await connectToDaemon({ host });
    // COMPAT(durableCommands): added in v0.6.1, remove gate after 2027-02-26.
    if (client.getLastServerInfoMessage()?.features?.durableCommands !== true) {
      await client.close().catch(() => {});
      throw commandError("DAEMON_UPDATE_REQUIRED", "Update the host to use durable commands.");
    }
    return client;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && "message" in error) {
      throw error;
    }
    throw commandError(
      "DAEMON_NOT_RUNNING",
      `Cannot connect to daemon at ${getDaemonHost({ host })}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function single(job: WatchdogJob): SingleResult<WatchdogRow> {
  return { type: "single", data: toRow(job), schema: { ...watchdogSchema, serialize: () => job } };
}

function toRow(job: WatchdogJob): WatchdogRow {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    delivery: job.deliveryStatus,
    agent: job.agentId,
    exitCode: job.result?.exitCode ?? null,
    updatedAt: job.updatedAt,
  };
}

function commandError(code: string, message: string): CommandError {
  return { code, message };
}

function resolveStartTarget(options: WatchdogOptions): {
  agentId: string;
  workspaceId: string;
  cwd: string;
} {
  const agentId = options.agent?.trim() || process.env.PASEO_AGENT_ID?.trim();
  const workspaceId = options.workspace?.trim() || process.env.PASEO_WORKSPACE_ID?.trim();
  const cwd = options.cwd?.trim();
  if (!agentId) throw commandError("WATCHDOG_AGENT_REQUIRED", "Provide --agent or PASEO_AGENT_ID");
  if (!workspaceId) {
    throw commandError("WATCHDOG_WORKSPACE_REQUIRED", "Provide --workspace or PASEO_WORKSPACE_ID");
  }
  if (options.host !== undefined && !cwd) {
    throw commandError("WATCHDOG_CWD_REQUIRED", "--cwd is required when --host is specified");
  }
  return { agentId, workspaceId, cwd: cwd || process.cwd() };
}
