import { memo, useCallback, type ReactElement } from "react";
import { AgentTaskList } from "@/composer/task-list";
import { ComposerTrackBar } from "@/composer/tracks";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import {
  useArchiveFinishedSubagents,
  useArchiveSubagent,
  useDetachSubagent,
  useSubagentsForParent,
} from "@/subagents";
import { SubagentsTrack } from "@/subagents/track";
import { navigateToAgent } from "@/utils/navigate-to-agent";

/**
 * The pane's trackers — its subagents and its task list — as a row of pills over the foot of
 * the transcript.
 *
 * It is mounted inside the transcript's animated container rather than above the composer, and
 * that placement is the whole design: the pills paint over the timeline, so scrolled content
 * passes under them instead of stopping at a band, and the container carries the same keyboard
 * transform the composer does, so the pills stay glued to its top edge while the keyboard moves.
 *
 * Its state was living in the composer only because that is where it used to render. None of it
 * is composer state — a subagent row opens a tab, the task list reads the agent's stream.
 */
export const AgentTracks = memo(function AgentTracks({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement {
  const { openTab } = usePaneContext();
  const subagentRows = useSubagentsForParent({ serverId, parentAgentId: agentId });
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const archiveSubagent = useArchiveSubagent({ serverId });
  const detachSubagent = useDetachSubagent({ serverId });
  const archiveFinishedSubagents = useArchiveFinishedSubagents({
    serverId,
    parentAgentId: agentId,
    rows: subagentRows,
  });

  const handleOpenSubagent = useCallback(
    (subagentId: string) => {
      navigateToAgent({ serverId, agentId: subagentId });
    },
    [serverId],
  );
  const handleOpenProviderSubagent = useCallback(
    (parentAgentId: string, subagentId: string) => {
      openTab({ kind: "provider_subagent", parentAgentId, subagentId });
    },
    [openTab],
  );

  return (
    <ComposerTrackBar>
      <SubagentsTrack
        rows={subagentRows}
        onOpenSubagent={handleOpenSubagent}
        onOpenProviderSubagent={handleOpenProviderSubagent}
        onArchiveSubagent={archiveSubagent}
        onArchiveFinished={archiveFinishedSubagents.archiveFinished}
        archiveFinishedStatus={archiveFinishedSubagents.status}
        onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
      />
      <AgentTaskList serverId={serverId} agentId={agentId} />
    </ComposerTrackBar>
  );
});
