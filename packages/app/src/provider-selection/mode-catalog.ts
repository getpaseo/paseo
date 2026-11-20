import type { AgentMode } from "@getpaseo/protocol/agent-types";

/**
 * The modes a composer offers for one provider: what the agent's own workspace
 * reports first, then every mode the host discovered in a warmed workspace.
 *
 * A profile is host-wide and stores only a mode id, so a mode one project
 * defines must stay selectable where that profile is applied. The workspace
 * list comes first because it is what the provider will actually accept for
 * this directory; the host list only fills in what would otherwise be missing.
 *
 * Ids are deduplicated, the first occurrence wins, and the workspace array is
 * returned unchanged when nothing is added so callers keep referential
 * stability across renders.
 */
export function mergeAgentModes(
  workspaceModes: AgentMode[],
  hostModes: AgentMode[] | undefined,
): AgentMode[] {
  if (!hostModes || hostModes.length === 0) {
    return workspaceModes;
  }
  const seen = new Set(workspaceModes.map((mode) => mode.id));
  const extra = hostModes.filter((mode) => !seen.has(mode.id));
  if (extra.length === 0) {
    return workspaceModes;
  }
  return [...workspaceModes, ...extra];
}
