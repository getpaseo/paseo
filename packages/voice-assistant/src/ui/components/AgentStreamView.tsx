import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Skull, XCircle, Loader2, CheckCircle } from "lucide-react";
import type { AgentStatus } from "../../server/acp/types.js";
import type { SessionNotification } from "@agentclientprotocol/sdk";

export interface AgentStreamViewProps {
  agentId: string;
  agent: {
    id: string;
    status: AgentStatus;
    createdAt: Date;
    type: "claude";
  };
  updates: Array<{
    timestamp: Date;
    notification: SessionNotification;
  }>;
  onBack: () => void;
  onKillAgent: (agentId: string) => void;
  onCancelAgent: (agentId: string) => void;
}

function getStatusColor(status: AgentStatus): string {
  switch (status) {
    case "initializing":
      return "#f59e0b";
    case "ready":
      return "#3b82f6";
    case "processing":
      return "#fbbf24";
    case "completed":
      return "#22c55e";
    case "failed":
      return "#ef4444";
    case "killed":
      return "#9ca3af";
    default:
      return "#9ca3af";
  }
}

function getStatusIcon(status: AgentStatus) {
  switch (status) {
    case "initializing":
      return <Loader2 size={16} className="spinning" />;
    case "processing":
      return <Loader2 size={16} className="spinning" />;
    case "ready":
      return <CheckCircle size={16} />;
    case "completed":
      return <CheckCircle size={16} />;
    case "failed":
      return <XCircle size={16} />;
    case "killed":
      return <XCircle size={16} />;
    default:
      return null;
  }
}

function formatTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(date);
}

function AgentUpdate({
  update,
}: {
  update: { timestamp: Date; notification: SessionNotification };
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const notification = update.notification as any;

  // Parse different notification types
  if (notification.type === "sessionUpdate") {
    const sessionUpdate = notification.sessionUpdate || {};

    // Handle message chunks
    if (sessionUpdate.kind === "agent_message_chunk") {
      return (
        <div className="agent-update message-chunk">
          <div className="update-timestamp">{formatTimestamp(update.timestamp)}</div>
          <div className="update-content">
            <div className="message-text">{sessionUpdate.chunk || ""}</div>
          </div>
        </div>
      );
    }

    // Handle tool calls
    if (sessionUpdate.kind === "tool_call") {
      return (
        <div className="agent-update tool-call">
          <div className="update-header" onClick={() => setIsExpanded(!isExpanded)}>
            <div className="update-timestamp">{formatTimestamp(update.timestamp)}</div>
            <div className="update-title">Tool Call: {sessionUpdate.toolName || "unknown"}</div>
          </div>
          {isExpanded && sessionUpdate.arguments && (
            <div className="update-content">
              <pre className="tool-arguments">
                {JSON.stringify(sessionUpdate.arguments, null, 2)}
              </pre>
            </div>
          )}
        </div>
      );
    }

    // Handle tool call updates
    if (sessionUpdate.kind === "tool_call_update") {
      return (
        <div className="agent-update tool-call-update">
          <div className="update-timestamp">{formatTimestamp(update.timestamp)}</div>
          <div className="update-content">
            <div className="tool-update-status">
              {sessionUpdate.status || "updating"}
            </div>
          </div>
        </div>
      );
    }

    // Handle available commands
    if (sessionUpdate.kind === "available_commands_update") {
      const commands = sessionUpdate.commands || [];
      return (
        <div className="agent-update available-commands">
          <div className="update-header" onClick={() => setIsExpanded(!isExpanded)}>
            <div className="update-timestamp">{formatTimestamp(update.timestamp)}</div>
            <div className="update-title">Available Commands ({commands.length})</div>
          </div>
          {isExpanded && (
            <div className="update-content">
              <ul className="commands-list">
                {commands.map((cmd: any, idx: number) => (
                  <li key={idx}>{cmd.name || cmd}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      );
    }

    // Generic session update
    return (
      <div className="agent-update session-update">
        <div className="update-timestamp">{formatTimestamp(update.timestamp)}</div>
        <div className="update-content">
          <pre className="update-data">
            {JSON.stringify(sessionUpdate, null, 2)}
          </pre>
        </div>
      </div>
    );
  }

  // Fallback for unknown notification types
  return (
    <div className="agent-update unknown">
      <div className="update-timestamp">{formatTimestamp(update.timestamp)}</div>
      <div className="update-content">
        <pre className="update-data">
          {JSON.stringify(notification, null, 2)}
        </pre>
      </div>
    </div>
  );
}

export function AgentStreamView({
  agentId,
  agent,
  updates,
  onBack,
  onKillAgent,
  onCancelAgent,
}: AgentStreamViewProps) {
  const updatesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new updates arrive
  useEffect(() => {
    updatesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [updates]);

  const canCancel = agent.status === "processing";
  const canKill = agent.status !== "killed" && agent.status !== "completed";

  return (
    <div className="agent-stream-view">
      <div className="agent-header">
        <button
          className="back-button"
          onClick={onBack}
          type="button"
        >
          <ArrowLeft size={20} />
          <span>Back to Chat</span>
        </button>

        <div className="agent-info">
          <div className="agent-id">
            Agent: <span className="agent-id-value">{agentId.substring(0, 8)}</span>
          </div>
          <div
            className="agent-status-badge"
            style={{ backgroundColor: getStatusColor(agent.status) }}
          >
            {getStatusIcon(agent.status)}
            <span>{agent.status}</span>
          </div>
          <div className="agent-created">
            Created: {formatTimestamp(agent.createdAt)}
          </div>
        </div>

        <div className="agent-controls">
          {canCancel && (
            <button
              className="control-button cancel-button"
              onClick={() => onCancelAgent(agentId)}
              type="button"
            >
              <XCircle size={16} />
              <span>Cancel</span>
            </button>
          )}
          {canKill && (
            <button
              className="control-button kill-button"
              onClick={() => onKillAgent(agentId)}
              type="button"
            >
              <Skull size={16} />
              <span>Kill</span>
            </button>
          )}
        </div>
      </div>

      <div className="agent-updates-container">
        <div className="agent-updates-list">
          {updates.length === 0 ? (
            <div className="no-updates">
              <p>No updates yet. Waiting for agent activity...</p>
            </div>
          ) : (
            updates.map((update, idx) => (
              <AgentUpdate key={idx} update={update} />
            ))
          )}
          <div ref={updatesEndRef} />
        </div>
      </div>
    </div>
  );
}
