import { Terminal, Bot, Code } from "lucide-react";
import type { AgentStatus } from "../../server/acp/types.js";

export interface ActiveProcessesProps {
  terminals: Array<{ id: string; name: string }>;
  agents: Array<{
    id: string;
    status: AgentStatus;
    type: "claude";
    currentModeId?: string;
    availableModes?: Array<{ id: string; name: string; description?: string | null }>;
  }>;
  commands: Array<{
    id: string;
    name: string;
    workingDirectory: string;
    currentCommand: string;
    isDead: boolean;
    exitCode: number | null;
  }>;
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

function getModeName(modeId?: string, availableModes?: Array<{ id: string; name: string }>): string {
  if (!modeId) return "unknown";
  const mode = availableModes?.find(m => m.id === modeId);
  return mode?.name || modeId;
}

function getModeColor(modeId?: string): string {
  if (!modeId) return "#9ca3af"; // gray

  // Color based on common mode types
  if (modeId.includes("ask")) return "#f59e0b"; // orange - asks permission
  if (modeId.includes("code")) return "#22c55e"; // green - writes code
  if (modeId.includes("architect") || modeId.includes("plan")) return "#3b82f6"; // blue - plans

  return "#9ca3af"; // gray - unknown
}

export function ActiveProcesses({
  terminals,
  agents,
  commands,
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

        {agents.map((agent) => {
          const modeName = getModeName(agent.currentModeId, agent.availableModes);
          const modesList = agent.availableModes?.map(m => m.name).join(", ") || "unknown";

          return (
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
              title={`Status: ${getAgentStatusLabel(agent.status)} | Mode: ${modeName} | Available: ${modesList}`}
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
              <span
                className="session-mode-badge"
                style={{
                  backgroundColor: getModeColor(agent.currentModeId),
                  opacity: 0.3,
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  marginLeft: "4px",
                }}
                title={`Mode: ${modeName}`}
              />
            </button>
          );
        })}

        {commands.map((command) => (
          <div
            key={`command-${command.id}`}
            className="process-pill command"
            title={`${command.currentCommand} | ${command.workingDirectory}${command.isDead ? ` | Exit code: ${command.exitCode}` : ""}`}
          >
            <Code size={14} />
            <span className="process-name">
              {command.name || command.currentCommand.substring(0, 20)}
            </span>
            <span
              className={`process-status-indicator ${command.isDead ? "dead" : "running"}`}
              style={{
                backgroundColor: command.isDead
                  ? command.exitCode === 0
                    ? "#22c55e"
                    : "#ef4444"
                  : "#3b82f6",
              }}
              title={command.isDead ? `Exited: ${command.exitCode}` : "Running"}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
