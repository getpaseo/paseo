export type StatusLoaderBucket =
  | "needs_input"
  | "failed"
  | "running"
  | "attention"
  | "waiting_on_subagent"
  | "done";

export function shouldRenderSyncedStatusLoader(input: {
  bucket: StatusLoaderBucket | null | undefined;
}): boolean {
  // Only the agent's own turn earns the ring. Waiting on a subagent is still work in the
  // workspace, but the ring is the app's mark for "this agent's turn is live".
  return input.bucket === "running";
}
