import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  acceptNoteProblem,
  acceptRefusal,
  criteriaToWaive,
  type WaivedCriteria,
} from "@getpaseo/protocol/goal/acceptance";
import type { Goal } from "@getpaseo/protocol/goal/types";
import { MAX_ACCEPT_NOTE_CHARS } from "@getpaseo/protocol/goal/types";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import { connectGoalClient, toGoalCommandError, type GoalCommandOptions } from "./shared.js";
import { refuseInAgentShell } from "./transition.js";

export interface GoalAcceptOptions extends GoalCommandOptions {
  note?: string;
  yes?: boolean;
}

export interface GoalAcceptRow {
  id: string;
  status: string;
  waived: string[];
  note: string;
}

const acceptSchema: OutputSchema<GoalAcceptRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 38 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "WAIVED", field: (row) => row.waived.join(", ") || "-", width: 30 },
    { header: "NOTE", field: "note", width: 60 },
  ],
};

/** The note, trimmed; refused when missing, empty or too long. */
export function requireAcceptNote(note: string | undefined): string {
  if (note === undefined) throw new Error("--note is required: say why you accept the goal as is");
  const problem = acceptNoteProblem(note);
  if (problem === "empty") throw new Error("--note must not be empty");
  if (problem === "too_long") {
    throw new Error(`--note is longer than ${MAX_ACCEPT_NOTE_CHARS} characters`);
  }
  return note.trim();
}

/** What the accept will waive, as a person reads it before confirming. */
export function describeWaiver(goal: Goal, groups: WaivedCriteria): string {
  const lines = [
    `Accept goal ${goal.id} as is: it becomes completed with these criteria waived. This cannot be undone.`,
  ];
  const list = (title: string, items: WaivedCriteria["notMet"]) => {
    if (items.length === 0) return;
    lines.push(`${title}:`, ...items.map((c) => `  - ${c.id}: ${c.text}`));
  };
  list("Not met", groups.notMet);
  list("Never checked", groups.neverChecked);
  if (groups.notMet.length + groups.neverChecked.length === 0) {
    lines.push("No criterion is waived: every criterion was verified.");
  }
  return lines.join("\n");
}

export interface AcceptConfirmation {
  interactive: boolean;
  structured: boolean;
  confirm(message: string): Promise<boolean>;
}

/** Accept cannot be undone, so it asks first; without a terminal, or with structured output, it needs --yes. */
export async function confirmGoalAccept(
  summary: string,
  options: Pick<GoalAcceptOptions, "yes">,
  interaction: AcceptConfirmation,
): Promise<boolean> {
  if (options.yes) return true;
  if (interaction.structured || !interaction.interactive) {
    throw new Error(`${summary}\nConfirmation required; rerun with --yes.`);
  }
  return interaction.confirm(`${summary}\nAccept? [y/N] `);
}

function terminalConfirmation(options: GoalCommandOptions): AcceptConfirmation {
  return {
    interactive: process.stdin.isTTY === true,
    structured:
      options.json === true ||
      ["json", "yaml"].includes(options.format?.trim().toLowerCase() ?? ""),
    confirm: async (message) => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^(y|yes)$/i.test((await prompt.question(message)).trim());
      } catch {
        return false;
      } finally {
        prompt.close();
      }
    },
  };
}

/**
 * `paseo goal accept <id> --note "..."`: a person accepts a failed goal as is, completing it with
 * every criterion still unverified waived. Refused in an agent's shell. Exits non-zero when it
 * is refused or declined.
 */
export async function runAcceptCommand(
  id: string,
  options: GoalAcceptOptions,
  _command: Command,
): Promise<SingleResult<GoalAcceptRow>> {
  let note: string;
  try {
    refuseInAgentShell("paseo goal accept");
    note = requireAcceptNote(options.note);
  } catch (error) {
    throw toGoalCommandError("GOAL_ACCEPT_FAILED", "accept goal", error);
  }
  const client = await connectGoalClient(options.daemonTarget);
  try {
    if (!client.supportsGoalAccept()) {
      throw new Error("Update the host to accept a failed goal as is.");
    }
    const { goal, error } = await client.goalInspect(id);
    if (error || !goal) throw new Error(error ?? `Goal not found: ${id}`);
    const refusal = acceptRefusal(goal);
    if (refusal) throw new Error(`Goal ${id} cannot be accepted as is: ${refusal}`);
    // One group holds them all; criteriaToWaive says why.
    const groups = criteriaToWaive(goal);
    const confirmed = await confirmGoalAccept(
      describeWaiver(goal, groups),
      options,
      terminalConfirmation(options),
    );
    if (!confirmed) {
      throw { code: "GOAL_ACCEPT_DECLINED", message: "Goal not accepted" };
    }
    const criterionIds = [...groups.notMet, ...groups.neverChecked].map((c) => c.id);
    const payload = await client.goalOutcomeAccept({
      goalId: id,
      criterionIds,
      note,
      client: "cli",
      eventId: randomUUID(),
    });
    if (payload.error || !payload.goal) throw new Error(payload.error ?? "Daemon returned no goal");
    const accepted = payload.goal;
    return {
      type: "single",
      data: {
        id: accepted.id,
        status: accepted.status,
        waived: accepted.criteria.filter((c) => c.waived).map((c) => c.id),
        note: accepted.accepted?.note ?? note,
      },
      schema: acceptSchema,
    };
  } catch (error) {
    throw toGoalCommandError("GOAL_ACCEPT_FAILED", "accept goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}
