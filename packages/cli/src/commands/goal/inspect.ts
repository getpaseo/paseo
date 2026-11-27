import type { Command } from "commander";
import { goalRoleThinking } from "@getpaseo/protocol/goal/thinking";
import { excludedWaitMs } from "@getpaseo/protocol/goal/time-limit";
import type { Goal, GoalEvent, Task } from "@getpaseo/protocol/goal/types";
import type { ListResult, OutputOptions, OutputSchema } from "../../output/index.js";
import { renderTable } from "../../output/table.js";
import { formatDuration, formatUsage, taskTimes, taskUsage } from "./progress.js";
import { connectGoalClient, toGoalCommandError, type GoalCommandOptions } from "./shared.js";
import { goalUsageRows, goalUsageSchema, type GoalUsageRow } from "./usage.js";

export interface GoalInspectOptions extends GoalCommandOptions {
  /** List usage per agent, role and in total instead of the tasks. */
  usage?: boolean;
}

interface GoalTaskRow {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  rework: string;
  dependsOn: string;
  provider: string;
  thinking: string;
  elapsed: string;
  usage: string;
  title: string;
}

const taskSchema: OutputSchema<GoalTaskRow> = {
  idField: "id",
  columns: [
    { header: "TASK", field: "id", width: 16 },
    { header: "KIND", field: "kind", width: 10 },
    { header: "STATUS", field: "status", width: 11 },
    { header: "TRIES", field: "attempts", width: 6 },
    { header: "REWORK", field: "rework", width: 7 },
    { header: "DEPENDS ON", field: "dependsOn", width: 16 },
    { header: "PROVIDER", field: "provider", width: 10 },
    { header: "THINKING", field: "thinking", width: 9 },
    { header: "ELAPSED", field: "elapsed", width: 9 },
    { header: "USAGE", field: "usage", width: 30 },
    { header: "TITLE", field: "title", width: 36 },
  ],
};

interface GoalRevisionRow {
  id: string;
  source: string;
  status: string;
  decidedAt: string;
  reason: string;
}

const revisionSchema: OutputSchema<GoalRevisionRow> = {
  idField: "id",
  columns: [
    { header: "REVISION", field: "id", width: 42 },
    { header: "SOURCE", field: "source", width: 7 },
    { header: "STATUS", field: "status", width: 11 },
    { header: "DECIDED", field: "decidedAt", width: 24 },
    { header: "REASON", field: "reason", width: 60 },
  ],
};

/** The goal's plan revisions, one line each, oldest first. */
export function goalRevisionRows(goal: Pick<Goal, "planRevisions">): GoalRevisionRow[] {
  return (goal.planRevisions ?? []).map((r) => ({
    id: r.id,
    source: r.source,
    status: r.status,
    decidedAt: r.decidedAt ?? "-",
    reason: r.reason.split("\n")[0] ?? "",
  }));
}

/** Set once a recovery added work after verification had started, or null. */
export function verificationRoundLine(goal: Pick<Goal, "verificationRound">): string | null {
  return goal.verificationRound
    ? `Verification round ${goal.verificationRound}: a recovery added work, so every criterion is verified again.`
    : null;
}

/** The id suffix of the wait.ended a daemon records at boot for a wait its last process left open. */
const RESTARTED_WAIT_SUFFIX = ":restarted";

/** Events after which the goal no longer runs, so no wait stays open. */
const GOAL_ENDINGS: ReadonlySet<string> = new Set([
  "goal.failed",
  "goal.cancelled",
  "goal.completed",
  "goal.accepted",
]);

/**
 * Each wait for a person's answer, oldest first, and the total the time limit leaves out. A wait
 * closed at a restart includes the time the daemon was down: the gap between the last event
 * before the restart and the one that closed the wait.
 */
export function goalWaitLines(
  goal: Pick<Goal, "runs" | "waits">,
  events: readonly GoalEvent[],
  nowMs: number,
): string[] {
  const lines: string[] = [];
  const open = new Map<string, { at: number; label: string; runId?: string }>();
  let previousAt = Number.NaN;
  const close = (agentId: string, at: number, downtimeMs: number | null) => {
    const wait = open.get(agentId);
    if (!wait) return;
    open.delete(agentId);
    const down =
      downtimeMs === null ? "" : ` (includes daemon downtime ${formatDuration(downtimeMs)})`;
    lines.push(`Waited for an answer, ${wait.label}: ${formatDuration(at - wait.at)}${down}`);
  };
  for (const event of events) {
    const at = Date.parse(event.at);
    if (event.type === "wait.started") {
      const taskId = goal.runs.find((r) => r.id === event.runId)?.taskId;
      const label = event.runId ? `${taskId ?? "?"} (${event.runId})` : event.role;
      open.set(event.agentId, { at, label, ...(event.runId ? { runId: event.runId } : {}) });
    } else if (event.type === "wait.ended") {
      const restarted = event.id.endsWith(RESTARTED_WAIT_SUFFIX) && !Number.isNaN(previousAt);
      close(event.agentId, at, restarted ? Math.max(0, at - previousAt) : null);
    } else if (event.type === "run.finished") {
      for (const [agentId, wait] of open) if (wait.runId === event.runId) close(agentId, at, null);
    } else if (GOAL_ENDINGS.has(event.type)) {
      for (const agentId of open.keys()) close(agentId, at, null);
    }
    // Every wait closed at one restart measures the downtime from the last event before it.
    if (!event.id.endsWith(RESTARTED_WAIT_SUFFIX)) previousAt = at;
  }
  for (const wait of open.values()) {
    lines.push(`Waiting for an answer, ${wait.label}: ${formatDuration(nowMs - wait.at)} so far`);
  }
  const excluded = excludedWaitMs(goal, nowMs);
  if (excluded > 0) {
    lines.push(
      `Not counted toward the time limits: ${formatDuration(excluded)} waiting for answers`,
    );
  }
  return lines;
}

/** The task table, then the plan revisions and the verification round when the goal has them. */
function renderTasksAndRevisions(
  tasks: ListResult<GoalTaskRow>,
  goal: Pick<Goal, "planRevisions" | "verificationRound">,
  options: OutputOptions,
  waits: string[] = [],
): string {
  const sections = [renderTable<GoalTaskRow>({ ...tasks, schema: taskSchema }, options)];
  const revisions = goalRevisionRows(goal);
  if (revisions.length > 0) {
    const revisionTable = renderTable<GoalRevisionRow>(
      { type: "list", data: revisions, schema: revisionSchema },
      options,
    );
    sections.push(`Plan revisions:\n${revisionTable}`);
  }
  const round = verificationRoundLine(goal);
  if (round) sections.push(round);
  if (waits.length > 0) sections.push(waits.join("\n"));
  return sections.join("\n\n");
}

/** What the task's last run started with, else what the goal asks for, else "-". */
function taskThinking(goal: Goal, task: Task): string {
  const run = goal.runs.findLast((r) => r.taskId === task.id);
  return (
    run?.thinking ??
    (goal.config ? goalRoleThinking(goal.config, "worker", task) : undefined) ??
    "-"
  );
}

/** `paseo goal inspect --usage`: usage per agent, then per role and the goal's total. */
export async function runInspectUsageCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<ListResult<GoalUsageRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const payload = await client.goalInspect(id);
    if (payload.error || !payload.goal) {
      throw new Error(payload.error ?? `Goal not found: ${id}`);
    }
    const goal = payload.goal;
    const rows = goalUsageRows(goal);
    if (!rows) throw new Error("Update the host to see usage per agent.");
    return {
      type: "list",
      data: rows,
      schema: {
        ...goalUsageSchema,
        serialize: () => ({
          usage: goal.usage ?? null,
          usageByRole: goal.usageByRole ?? null,
          usageBreakdown: goal.usageBreakdown ?? [],
          usageBreakdownTruncated: goal.usageBreakdownTruncated ?? 0,
        }),
      },
    };
  } catch (error) {
    throw toGoalCommandError("GOAL_INSPECT_FAILED", "inspect goal usage", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runInspectCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<ListResult<GoalTaskRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const payload = await client.goalInspect(id);
    if (payload.error || !payload.goal) {
      throw new Error(payload.error ?? `Goal not found: ${id}`);
    }
    const goal = payload.goal;
    const now = Date.now();
    return {
      type: "list",
      data: goal.tasks.map((task) => {
        const { startedAt, endedAt } = taskTimes(goal, task);
        return {
          id: task.id,
          kind: task.kind,
          status: task.status,
          attempts: task.attempts,
          rework: task.rework ? `${task.rework.reason} #${task.rework.round}` : "-",
          dependsOn: task.dependsOn.join(",") || "-",
          provider: task.provider ?? "-",
          thinking: taskThinking(goal, task),
          elapsed: startedAt
            ? formatDuration((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt))
            : "-",
          usage: formatUsage(taskUsage(goal, task)),
          title: task.title,
        };
      }),
      schema: {
        ...taskSchema,
        renderHuman: (result, outputOptions) =>
          renderTasksAndRevisions(
            result as ListResult<GoalTaskRow>,
            goal,
            outputOptions,
            goalWaitLines(goal, payload.events, now),
          ),
        // JSON output carries the full goal and its event history.
        serialize: () => ({ goal, events: payload.events }),
      },
    };
  } catch (error) {
    throw toGoalCommandError("GOAL_INSPECT_FAILED", "inspect goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}
