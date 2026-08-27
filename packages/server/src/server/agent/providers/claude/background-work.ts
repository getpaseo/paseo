import { z } from "zod";

import type { AgentBackgroundWork } from "../../agent-sdk-types.js";

type AgentBackgroundTask = AgentBackgroundWork["tasks"][number];

/**
 * Claude Code's Stop hook is the only place a session's in-flight background work and pending
 * schedules are exposed — there is no cron lifecycle hook and no control request that lists them.
 *
 * Both arrays are optional and documented as empty when nothing is in flight, so an absent field
 * and an empty array mean the same thing: nothing pending.
 */
const ClaudeBackgroundTaskSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    status: z.string(),
    description: z.string().optional(),
    command: z.string().optional(),
    agent_type: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

const ClaudeSessionCronSchema = z
  .object({
    id: z.string(),
    schedule: z.string(),
    recurring: z.boolean(),
    prompt: z.string().optional(),
  })
  .passthrough();

const ClaudeStopHookSchema = z
  .object({
    hook_event_name: z.literal("Stop"),
    background_tasks: z.array(ClaudeBackgroundTaskSchema).optional(),
    session_crons: z.array(ClaudeSessionCronSchema).optional(),
  })
  .passthrough();

/**
 * Returns null for anything that is not a Stop hook payload, so a caller can register this
 * against several events without having to pre-filter. A Stop payload carrying neither array
 * still returns a value: "nothing pending" has to be able to clear a stale strip.
 */
export function readClaudeBackgroundWork(input: unknown): AgentBackgroundWork | null {
  const parsed = ClaudeStopHookSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }

  return {
    tasks: (parsed.data.background_tasks ?? []).map((task) => {
      const mapped: AgentBackgroundTask = {
        id: task.id,
        type: task.type,
        status: task.status,
        description: task.description ?? "",
      };
      if (task.command) mapped.command = task.command;
      if (task.agent_type) mapped.agentType = task.agent_type;
      if (task.name) mapped.name = task.name;
      return mapped;
    }),
    crons: (parsed.data.session_crons ?? []).map((cron) => ({
      id: cron.id,
      schedule: cron.schedule,
      recurring: cron.recurring,
      prompt: cron.prompt ?? "",
    })),
  };
}
