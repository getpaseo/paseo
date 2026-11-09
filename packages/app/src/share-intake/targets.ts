import {
  filterAndRankBuiltInResults,
  joinSubtitleParts,
  type CommandCenterSearchFields,
} from "@/command-center/results";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { ProjectSummary } from "@/utils/projects";
import { shortenPath } from "@/utils/shorten-path";
import type { ShareTarget } from "./deliver";

export interface ShareTargetRow {
  id: string;
  target: ShareTarget;
  title: string;
  subtitle: string;
  activityAt: Date | null;
}

export interface ShareTargetRows {
  agents: ShareTargetRow[];
  workspaces: ShareTargetRow[];
}

/** The rows the picker can offer, before search. Labels match the command center's. */
export function buildShareTargetRows(input: {
  agents: readonly AggregatedAgent[];
  projects: readonly ProjectSummary[];
  showHost: boolean;
  agentTitle: (agent: AggregatedAgent) => string;
}): ShareTargetRows {
  const workspaces: ShareTargetRow[] = [];
  const workspaceTitleByKey = new Map<string, string>();
  for (const project of input.projects) {
    for (const host of project.hosts) {
      for (const workspace of host.workspaces) {
        if (workspace.archivingAt) continue;
        const title = workspace.title ?? workspace.name;
        workspaceTitleByKey.set(`${host.serverId}:${workspace.id}`, title);
        workspaces.push({
          id: `workspace:${host.serverId}:${workspace.id}`,
          target: { kind: "workspace", serverId: host.serverId, workspaceId: workspace.id },
          title,
          subtitle: joinSubtitleParts([
            input.showHost ? host.serverName : null,
            project.projectName,
            workspace.currentBranch,
          ]),
          activityAt: workspace.statusEnteredAt,
        });
      }
    }
  }
  const agents = input.agents.map<ShareTargetRow>((agent) => {
    const workspaceTitle = agent.workspaceId
      ? workspaceTitleByKey.get(`${agent.serverId}:${agent.workspaceId}`)
      : undefined;
    return {
      id: `agent:${agent.serverId}:${agent.id}`,
      target: { kind: "agent", serverId: agent.serverId, agentId: agent.id },
      title: input.agentTitle(agent),
      subtitle: joinSubtitleParts([
        input.showHost ? agent.serverLabel : null,
        workspaceTitle ?? shortenPath(agent.cwd),
      ]),
      activityAt: agent.lastActivityAt,
    };
  });
  return { agents, workspaces };
}

const searchFields = (row: ShareTargetRow): CommandCenterSearchFields => ({
  visible: [row.title, row.subtitle],
  hidden: [],
});

/** With no query, the most recent few of each; with one, every match, best first. */
export function rankShareTargetRows(rows: ShareTargetRows, query: string): ShareTargetRows {
  return {
    agents: filterAndRankBuiltInResults(rows.agents, query, searchFields),
    workspaces: filterAndRankBuiltInResults(rows.workspaces, query, searchFields),
  };
}
