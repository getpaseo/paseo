export type StatusLoaderBucket =
  | "needs_input"
  | "failed"
  | "running"
  | "attention"
  | "needs_follow_up"
  | "done";

export function shouldRenderSyncedStatusLoader(input: {
  bucket: StatusLoaderBucket | null | undefined;
}): boolean {
  return input.bucket === "running";
}
