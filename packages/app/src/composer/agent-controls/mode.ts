import type { DraftAgentControlsProps } from "@/composer/agent-controls";

export function resolveAgentControlsMode(agentControls?: DraftAgentControlsProps) {
  return agentControls ? "draft" : "ready";
}
