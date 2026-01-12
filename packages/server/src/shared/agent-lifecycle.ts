export const AGENT_LIFECYCLE_STATUSES = [
  "initializing",
  "idle",
  "running",
  "error",
  "closed",
] as const;

export type AgentLifecycleStatus =
  (typeof AGENT_LIFECYCLE_STATUSES)[number];
