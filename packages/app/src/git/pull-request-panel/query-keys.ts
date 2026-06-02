export const prPaneTimelineQueryKind = "prPaneTimeline";

export function prPaneTimelineQueryKey({
  serverId,
  cwd,
  prNumber,
}: {
  serverId: string;
  cwd: string;
  prNumber: number | null;
}) {
  return [prPaneTimelineQueryKind, serverId, cwd, prNumber] as const;
}
