import type { AgentSnapshotPayload, ProjectPlacementPayload } from "@getpaseo/protocol/messages";
import { scoreTextFields } from "@getpaseo/protocol/search/text-match";

export interface AgentHistorySearchCandidate {
  agent: AgentSnapshotPayload;
  project: ProjectPlacementPayload;
}

/** Search the names people recall, never an incomplete subset of transcripts. */
export function matchesAgentHistoryQuery(
  query: string,
  { agent, project }: AgentHistorySearchCandidate,
): boolean {
  return (
    scoreTextFields(
      query,
      [
        project.workspaceName ?? "",
        agent.title ?? "",
        project.checkout.currentBranch ?? "",
        project.projectName,
      ],
      { typoTolerant: true },
    ) !== null
  );
}
