import type { AgentTimelinePromptIndexPayload } from "@getpaseo/client/internal/daemon-client";

export interface MessageTrailRailProps {
  prompts: AgentTimelinePromptIndexPayload["prompts"];
  onJumpToPrompt: (seq: number) => void;
}

export function MessageTrailRail(_props: MessageTrailRailProps): null {
  return null;
}
