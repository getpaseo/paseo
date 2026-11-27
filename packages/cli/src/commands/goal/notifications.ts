import type { Command } from "commander";
import type { ListResult, OutputSchema } from "../../output/index.js";
import { connectGoalClient, toGoalCommandError, type GoalCommandOptions } from "./shared.js";

interface NotificationRow {
  id: string;
  target: string;
  key: string;
  status: string;
  attempts: number;
  lastError: string;
  updatedAt: string;
}

const notificationSchema: OutputSchema<NotificationRow> = {
  idField: "id",
  columns: [
    { header: "TO", field: "target", width: 7 },
    { header: "KEY", field: "key", width: 22 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "TRIES", field: "attempts", width: 6 },
    { header: "UPDATED", field: "updatedAt", width: 24 },
    { header: "LAST ERROR", field: "lastError", width: 40 },
  ],
};

export async function runNotificationsCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<ListResult<NotificationRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const payload = await client.goalInspect(id);
    if (payload.error || !payload.goal) {
      throw new Error(payload.error ?? `Goal not found: ${id}`);
    }
    // Absent from daemons that predate recorded notifications.
    const notifications = payload.goal.notifications ?? [];
    return {
      type: "list",
      data: notifications.map((n) => ({
        id: `${n.target}:${n.key}`,
        target: n.target,
        key: n.key,
        status: n.status,
        attempts: n.attempts,
        lastError: n.lastError ?? "-",
        updatedAt: n.updatedAt,
      })),
      schema: {
        ...notificationSchema,
        // JSON output carries each notification in full, its text included.
        serialize: (row) => notifications.find((n) => `${n.target}:${n.key}` === row.id),
      },
    };
  } catch (error) {
    throw toGoalCommandError("GOAL_NOTIFICATIONS_FAILED", "list notifications", error);
  } finally {
    await client.close().catch(() => {});
  }
}
