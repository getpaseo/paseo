export type BackgroundTaskDisplayType = "shell" | "monitor" | "workflow" | "other";

export function normalizeBackgroundTaskDisplayType(type: string): BackgroundTaskDisplayType {
  const n = type.trim().toLowerCase();
  if (n === "shell" || n === "bash" || n === "local_bash") return "shell";
  if (n === "monitor") return "monitor";
  if (n === "workflow") return "workflow";
  return "other";
}
