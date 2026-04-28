import type { Agent } from "@/contexts/session-context";

type AgentStatus = Agent["status"];

const STATUS_COLOR_MAP: Record<AgentStatus, string> = {
  initializing: "#f59e0b",
  idle: "#22c55e",
  running: "#3b82f6",
  error: "#ef4444",
  closed: "#6b7280",
};

const STATUS_LABEL_MAP: Record<AgentStatus, string> = {
  initializing: "Initializing",
  idle: "Idle",
  running: "Running",
  error: "Error",
  closed: "Closed",
};

export function getAgentStatusColor(status: AgentStatus): string {
  return STATUS_COLOR_MAP[status] ?? "#9ca3af";
}

export function getAgentStatusLabel(status: AgentStatus): string {
  return STATUS_LABEL_MAP[status] ?? "Unknown";
}
