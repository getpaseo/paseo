import { Terminal, Bot } from "lucide-react";
import type { AgentStatus } from "../../server/acp/types.js";

export interface ActiveProcessesProps {
  terminals: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; status: AgentStatus; type: "claude" }>;
  activeProcessId: string | null;
  activeProcessType: "terminal" | "agent" | null;
  onSelectProcess: (id: string, type: "terminal" | "agent") => void;
  onBackToOrchestrator: () => void;
}

function getAgentStatusColor(status: AgentStatus): string {
  switch (status) {
    case "initializing":
      return "#f59e0b"; // orange
    case "ready":
      return "#3b82f6"; // blue
    case "processing":
      return "#fbbf24"; // yellow
    case "completed":
      return "#22c55e"; // green
    case "failed":
      return "#ef4444"; // red
    case "killed":
      return "#9ca3af"; // gray
    default:
      return "#9ca3af";
  }
}

function getAgentStatusLabel(status: AgentStatus): string {
  return status;
}

export function ActiveProcesses({
  terminals,
  agents,
  activeProcessId,
  activeProcessType,
  onSelectProcess,
  onBackToOrchestrator,
}: ActiveProcessesProps) {
  const hasActiveProcess = activeProcessId !== null && activeProcessType !== null;

  return (
    <div className="active-processes-bar">
      {hasActiveProcess && (
        <button
          className="back-to-orchestrator-button"
          onClick={onBackToOrchestrator}
          type="button"
        >
          Back to Chat
        </button>
      )}

      <div className="processes-pills">
        {terminals.map((terminal) => (
          <button
            key={`terminal-${terminal.id}`}
            className={`process-pill terminal ${
              activeProcessType === "terminal" && activeProcessId === terminal.id
                ? "active"
                : ""
            }`}
            onClick={() => onSelectProcess(terminal.id, "terminal")}
            type="button"
          >
            <Terminal size={14} />
            <span className="process-name">{terminal.name}</span>
            <span className="process-status-indicator running" />
          </button>
        ))}

        {agents.map((agent) => (
          <button
            key={`agent-${agent.id}`}
            className={`process-pill agent ${
              activeProcessType === "agent" && activeProcessId === agent.id
                ? "active"
                : ""
            }`}
            onClick={() => onSelectProcess(agent.id, "agent")}
            type="button"
            data-status={agent.status}
          >
            <Bot size={14} />
            <span className="process-name">
              {agent.id.substring(0, 8)}
            </span>
            <span
              className={`process-status-indicator ${agent.status}`}
              style={{ backgroundColor: getAgentStatusColor(agent.status) }}
              title={getAgentStatusLabel(agent.status)}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
