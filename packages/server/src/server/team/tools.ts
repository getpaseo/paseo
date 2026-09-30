import { z } from "zod";
import type { PaseoToolConfig, PaseoToolResult } from "../agent/tools/types.js";
import { PlannedItemSchema, TEAM_ROLE_LABEL, TeamReportPayloadSchema } from "./types.js";
import { TeamNotNeededError, type TeamService } from "./service.js";

type RegisterTool = (
  name: string,
  config: PaseoToolConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- validated by the catalog against inputSchema.
  handler: (input: any) => Promise<PaseoToolResult>,
) => void;

const ROLE_TOOLS: Record<string, string[]> = { po: ["team_report", "item_plan"] };

/**
 * Tools a seated team member may use. Seated sessions get nothing else from the PandaOS catalog,
 * so no worker can start agents, message other sessions or create schedules.
 */
export function isToolAllowedForTeamRole(role: string | undefined, tool: string): boolean {
  return role === undefined || (ROLE_TOOLS[role] ?? ["team_report"]).includes(tool);
}

export function resolveTeamRole(
  agentManager: { getAgent(id: string): { labels?: Record<string, string> } | null | undefined },
  callerAgentId: string | undefined,
  callerLabels?: Record<string, string>,
): string | undefined {
  if (!callerAgentId) return undefined;
  const labels = callerLabels ?? agentManager.getAgent(callerAgentId)?.labels;
  return labels?.[TEAM_ROLE_LABEL];
}

function text(value: string): PaseoToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function registerTeamTools(
  registerTool: RegisterTool,
  params: {
    teamService: TeamService | null | undefined;
    callerAgentId: string | undefined;
    teamRole: string | undefined;
  },
): void {
  const { teamService, callerAgentId, teamRole } = params;
  if (!teamService || !callerAgentId) return;
  const requireCaller = () => callerAgentId;

  if (teamRole) {
    registerTool(
      "team_report",
      {
        title: "Report to the team",
        description:
          "Finish your part of the current work item. Call exactly once at the end of your work with one of the allowed outcomes. The runtime attaches the item and state; you only report the result.",
        inputSchema: TeamReportPayloadSchema.shape,
      },
      async (input) =>
        text(await teamService.report(requireCaller(), TeamReportPayloadSchema.parse(input))),
    );
    if (isToolAllowedForTeamRole(teamRole, "item_plan")) {
      registerTool(
        "item_plan",
        {
          title: "Record the team plan",
          description:
            "PO only. Record every work item of the plan in one call: key, title, objective, acceptance criteria, dependencies and conflicts by key.",
          inputSchema: { items: z.array(PlannedItemSchema).min(1) },
        },
        async ({ items }) => text(await teamService.plan(requireCaller(), items)),
      );
    }
    return;
  }

  registerTool(
    "team_start",
    {
      title: "Start a team",
      description:
        "Hand a larger job to an internal team (PO plans, developers, tester and reviewer work it through). Use it for work that spans several changes or needs test and review; do small tasks yourself. You stay the only one who talks to the user; the team reports back to you.",
      inputSchema: {
        title: z.string().min(1),
        objective: z
          .string()
          .min(1)
          .describe("The full goal with context, constraints and what done means."),
        cwd: z.string().optional(),
        packId: z.string().optional(),
        force: z
          .boolean()
          .optional()
          .describe("Start the team even when Jev says one agent can do it."),
      },
    },
    async ({ title, objective, cwd, packId, force }) => {
      let state: Awaited<ReturnType<TeamService["startTeam"]>>;
      try {
        state = await teamService.startTeam({
          bossAgentId: requireCaller(),
          title,
          objective,
          cwd,
          packId,
          force,
        });
      } catch (error) {
        if (error instanceof TeamNotNeededError) return text(error.message);
        throw error;
      }
      return text(
        `Team ${state.team.id} started with pack ${state.team.packId}. The PO is planning; you will be notified.`,
      );
    },
  );

  registerTool(
    "team_status",
    {
      title: "Team status",
      description: "Show your teams, their items and the latest team events.",
      inputSchema: { teamId: z.string().optional() },
    },
    async ({ teamId }) => {
      const teams = teamId
        ? [(await teamService.status(teamId)).state]
        : await teamService.listForBoss(requireCaller());
      const out: string[] = [];
      for (const state of teams) {
        out.push(
          `## ${state.team.title} (${state.team.id}) — ${state.team.status}${state.team.pausedReason ? `: ${state.team.pausedReason}` : ""}`,
        );
        for (const item of Object.values(state.items)) {
          out.push(
            `- ${item.title}: ${item.phase}${item.reports.at(-1) ? ` — ${item.reports.at(-1)!.summary}` : ""}`,
          );
        }
        const events = (await teamService.status(state.team.id)).events.slice(-15);
        out.push(
          "",
          "Recent events:",
          ...events.map((e) => `- ${e.at.slice(11, 19)} ${e.actor.id}: ${e.text}`),
        );
      }
      return text(out.join("\n") || "No teams.");
    },
  );

  registerTool(
    "team_message",
    {
      title: "Answer the team",
      description: "Pass the user's answer to a team that is waiting for you.",
      inputSchema: { teamId: z.string(), text: z.string().min(1) },
    },
    async ({ teamId, text: body }) => {
      await teamService.message(teamId, body, { type: "boss", id: requireCaller() });
      return text("Passed on.");
    },
  );

  for (const [name, status] of [
    ["team_pause", "paused"],
    ["team_resume", "active"],
    ["team_cancel", "canceled"],
  ] as const) {
    registerTool(
      name,
      { title: name, description: `Set a team to ${status}.`, inputSchema: { teamId: z.string() } },
      async ({ teamId }) => {
        await teamService.setStatus(teamId, status, requireCaller());
        return text(`Team ${teamId} is ${status}.`);
      },
    );
  }
}
