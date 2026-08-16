export const prPaneTimelineQueryKind = "prPaneTimeline";

export function prPaneTimelineQueryKey({
  serverId,
  queryIdentity,
  cwd,
  prNumber,
}: {
  serverId: string;
  queryIdentity: readonly ["selected", string];
  cwd: string;
  prNumber: number | null;
}) {
  return [prPaneTimelineQueryKind, serverId, queryIdentity, cwd, prNumber] as const;
}

export const prPanePipelineQueryKind = "prPanePipeline";

export function prPanePipelineQueryKey({
  serverId,
  queryIdentity,
  cwd,
  pipelineId,
  changeRequestNumber,
}: {
  serverId: string;
  queryIdentity: readonly ["selected", string];
  cwd: string;
  pipelineId: number | null;
  /** MR iid the pipeline is fetched by; part of the key since the fetch routes by it. */
  changeRequestNumber: number;
}) {
  return [
    prPanePipelineQueryKind,
    serverId,
    queryIdentity,
    cwd,
    pipelineId,
    changeRequestNumber,
  ] as const;
}
