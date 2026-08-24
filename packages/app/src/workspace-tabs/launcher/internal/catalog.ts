export const PRIMARY_LAUNCH_ORDER = [
  "agent",
  "terminal",
  "changes",
  "files",
  "browser",
  "pullRequest",
] as const;

export const SUPPORTING_LAUNCH_ORDER = [
  "changes",
  "files",
  "terminal",
  "agent",
  "browser",
  "pullRequest",
] as const;

export type BuiltInLaunchItemId = (typeof PRIMARY_LAUNCH_ORDER)[number];

export function getBuiltInLaunchOrder(purpose: "primary" | "supporting") {
  return purpose === "supporting" ? SUPPORTING_LAUNCH_ORDER : PRIMARY_LAUNCH_ORDER;
}
