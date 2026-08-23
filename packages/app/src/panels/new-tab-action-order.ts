export type LauncherAction = "agent" | "terminal" | "changes" | "files" | "browser" | "pullRequest";

export function getLauncherActionOrder(isSidePanel: boolean): LauncherAction[] {
  if (isSidePanel) {
    return ["changes", "files", "terminal", "agent", "browser", "pullRequest"];
  }
  return ["agent", "terminal", "changes", "files", "browser", "pullRequest"];
}
