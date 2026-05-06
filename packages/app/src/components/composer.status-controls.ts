import type { DraftAgentStatusBarProps } from "./agent-status-bar";

export function resolveStatusControlMode(statusControls?: DraftAgentStatusBarProps) {
  return statusControls ? "draft" : "ready";
}
