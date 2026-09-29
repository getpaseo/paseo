import { Command } from "commander";
import {
  readDaemonInstance,
  isSameDaemonInstance,
  DaemonInstanceError,
  type DaemonInstance,
} from "@getpaseo/server/daemon-control";
import { setTimeout as delay } from "node:timers/promises";
import {
  RestartDrainConflictError,
  RestartDrainTimeoutError,
} from "@getpaseo/client/internal/daemon-client";
import type { RestartDrainingStatusPayload } from "@getpaseo/client/internal/daemon-client";
import { connectToDaemon } from "../../utils/client.js";
import { withOutput, type CommandOptions } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { describeDaemonTarget, type DaemonTarget } from "../../utils/daemon-target.js";
import { parseDurationMs, parseTimeoutMs, rejectRemovedLaunchFlags } from "./local-daemon.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function daemonRestartCommand(): Command {
  return rejectRemovedLaunchFlags(
    addJsonAndDaemonHostOptions(
      new Command("restart").description(
        "Restart the selected daemon worker, retaining its supervisor launch",
      ),
    ),
  )
    .option("--timeout <seconds>", "Replacement readiness deadline (default: 600)")
    .option(
      "--wait-idle",
      "Wait until every agent has settled before restarting (drains running turns). " +
        "An agent that runs this in its own foreground turn waits for itself until timeout; " +
        "schedule it in a detached session group instead. Prompt auto-resend after a restart " +
        "is a client-library behaviour; this one-shot CLI does not reconnect",
    )
    .option(
      "--idle-timeout <duration>",
      "Drain deadline before giving up (default: 30m); e.g. 90s, 10m, 1h",
    )
    .option(
      "--force",
      "Restart immediately, or with --wait-idle swap on drain timeout instead of failing",
    )
    .action(withOutput(runRestartCommand));
}

function formatDrainTimeout(error: RestartDrainTimeoutError): { code: string; message: string } {
  const running = error.runningAgents.length > 0 ? error.runningAgents.join(", ") : "(none)";
  return {
    code: "RESTART_DRAIN_TIMEOUT",
    message:
      `Drain timed out after ${error.idleTimeoutMs}ms; the daemon was not restarted. ` +
      `Still running: ${running}. Retry later or use --force to restart anyway.`,
  };
}

function drainProgressReporter() {
  let lastSignature = "";
  return (status: RestartDrainingStatusPayload) => {
    const agents =
      status.agents ??
      status.runningAgents.map((agentId) => ({
        agentId,
        title: null,
        lifecycle: "running",
        waitingForPermission: false,
      }));
    const pendingAdmissions = status.pendingAdmissions ?? 0;
    const signature = JSON.stringify([
      agents.map((agent) => [agent.agentId, agent.lifecycle, agent.waitingForPermission]),
      pendingAdmissions,
    ]);
    if (signature === lastSignature) return;
    lastSignature = signature;

    if (agents.length === 0 && pendingAdmissions === 0) {
      process.stderr.write("Waiting for idle before restart (drain complete)\n");
      return;
    }
    const permissionCount = agents.filter((agent) => agent.waitingForPermission).length;
    const lines = agents.map((agent) => {
      const name = agent.title ? `${agent.title} (${agent.agentId})` : agent.agentId;
      const permission = agent.waitingForPermission ? ", waiting for a human" : "";
      return `  - ${name} [${agent.lifecycle}${permission}]`;
    });
    const details = [
      `${agents.length} agent(s)`,
      ...(pendingAdmissions > 0 ? [`${pendingAdmissions} submission(s) starting`] : []),
      ...(permissionCount > 0 ? [`${permissionCount} waiting on a human`] : []),
    ].join(", ");
    process.stderr.write(`Waiting for idle before restart (${details}):\n${lines.join("\n")}\n`);
  };
}

function formatDrainConflict(error: RestartDrainConflictError): { code: string; message: string } {
  const running = error.runningAgents.length > 0 ? error.runningAgents.join(", ") : "(none)";
  return {
    code: "RESTART_DRAIN_IN_PROGRESS",
    message:
      "A restart drain is already in progress and owns the worker swap. " +
      `Still running: ${running}. Wait for it to finish, or use --force to restart immediately.`,
  };
}

async function awaitReplacementWorker(params: {
  target: DaemonTarget;
  instance: DaemonInstance | null;
  deadline: number;
  workerPid: number;
  serverId: string | undefined;
  acknowledged: boolean;
  checkSupervisor: () => Promise<void>;
}): Promise<{
  type: "single";
  data: {
    action: "restarted";
    target: string;
    supervisorPid: number | null;
    previousWorkerPid: number;
    workerPid: number;
    acknowledged: boolean;
  };
  schema: {
    idField: "action";
    columns: never[];
    renderHuman: () => string;
  };
}> {
  const { target, instance, deadline, workerPid, serverId, acknowledged, checkSupervisor } = params;
  const remaining = () => Math.max(1, deadline - Date.now());
  let lastError: unknown = "No replacement worker observed";

  while (Date.now() < deadline) {
    try {
      const replacement = await connectToDaemon({
        target,
        instance: instance ?? undefined,
        timeout: Math.min(1_000, remaining()),
      });
      try {
        if (replacement.getLastServerInfoMessage()?.serverId !== serverId)
          throw new Error("Connected peer identity changed");
        const status = await replacement.getDaemonStatus({
          timeout: Math.min(1_000, remaining()),
        });
        if (status.pid !== workerPid) {
          await checkSupervisor();
          return {
            type: "single" as const,
            data: {
              action: "restarted" as const,
              target: describeDaemonTarget(target),
              supervisorPid: instance?.pid ?? null,
              previousWorkerPid: workerPid,
              workerPid: status.pid,
              acknowledged,
            },
            schema: {
              idField: "action" as const,
              columns: [] as never[],
              renderHuman: () =>
                `Restarted worker ${workerPid} → ${status.pid} at ${describeDaemonTarget(target)}. Supervisor launch retained.`,
            },
          };
        }
      } finally {
        await replacement.close();
      }
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string } | null)?.code;
      if (code === "DAEMON_REPLACED" || code === "DAEMON_NOT_RUNNING") break;
      if (!isReconnectFailure(error)) throw error;
    }
    await delay(Math.min(100, remaining()));
  }
  throw {
    code: "RESTART_NOT_CONFIRMED",
    message: `Replacement was not confirmed for ${describeDaemonTarget(target)}. Restart acknowledged: ${acknowledged}. Last observation: ${String(lastError)}`,
  };
}

export async function runRestartCommand(options: CommandOptions, _command: Command) {
  const target = options.daemonTarget;
  const waitIdle = options.waitIdle === true;
  const force = options.force === true;
  const idleTimeoutMs = waitIdle
    ? parseDurationMs(options.idleTimeout, DEFAULT_IDLE_TIMEOUT_MS)
    : 0;
  // The drain runs before the worker swap, so extend the readiness deadline by
  // the drain budget; otherwise a long drain would look like a failed restart.
  const drainBudgetMs = waitIdle ? idleTimeoutMs : 0;
  const deadline = Date.now() + parseTimeoutMs(options.timeout) + drainBudgetMs;
  const instance = target.kind === "instance" ? await readDaemonInstance(target.home) : null;
  async function checkSupervisor() {
    if (target.kind !== "instance") return;
    const current = await readDaemonInstance(target.home);
    if (!current || !instance || !isSameDaemonInstance(instance, current))
      throw new DaemonInstanceError(
        "DAEMON_REPLACED",
        `Supervisor exited or was replaced for ${target.home}.`,
      );
  }
  if (target.kind === "instance" && !instance)
    throw new DaemonInstanceError(
      "DAEMON_NOT_RUNNING",
      `Daemon is not running for ${target.home}.`,
    );
  const client = await connectToDaemon({
    target,
    instance: instance ?? undefined,
    timeout: Math.max(1, deadline - Date.now()),
  });
  let workerPid: number;
  const serverId = client.getLastServerInfoMessage()?.serverId;
  let acknowledged = false;
  const reportDrain = drainProgressReporter();
  try {
    workerPid = (await client.getDaemonStatus({ timeout: Math.max(1, deadline - Date.now()) })).pid;
    await checkSupervisor();
    try {
      await client.restartServer("cli_restart", undefined, {
        timeout: Math.max(1, deadline - Date.now()),
        waitIdle,
        idleTimeoutMs,
        force,
        onDrainProgress: reportDrain,
      });
      acknowledged = true;
    } catch (error) {
      if (error instanceof RestartDrainTimeoutError) throw formatDrainTimeout(error);
      if (error instanceof RestartDrainConflictError) throw formatDrainConflict(error);
      if (!isReconnectFailure(error)) throw error;
    }
  } finally {
    await client.close();
  }
  return awaitReplacementWorker({
    target,
    instance,
    deadline,
    workerPid,
    serverId,
    acknowledged,
    checkSupervisor,
  });
}

function isReconnectFailure(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    [
      "DAEMON_CONNECTION_LOST",
      "DAEMON_REQUEST_TIMEOUT",
      "DAEMON_UNREACHABLE",
      "DAEMON_NOT_READY",
    ].includes(String(error.code)),
  );
}
