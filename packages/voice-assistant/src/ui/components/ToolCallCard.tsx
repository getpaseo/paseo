import { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle, Loader2, XCircle } from "lucide-react";

export interface ToolCallCardProps {
  toolName: string;
  args: any;
  result?: any;
  error?: any;
  status: "executing" | "completed" | "failed";
}

export function ToolCallCard({
  toolName,
  args,
  result,
  error,
  status,
}: ToolCallCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="tool-call-card" data-status={status}>
      <button
        className="tool-call-header"
        onClick={() => setIsExpanded(!isExpanded)}
        type="button"
      >
        <div className="tool-call-icon">
          {isExpanded ? (
            <ChevronDown size={16} />
          ) : (
            <ChevronRight size={16} />
          )}
        </div>
        <span className="tool-call-name">{toolName}</span>
        <div className="tool-call-status">
          {status === "executing" ? (
            <Loader2 size={14} className="status-icon spinning" />
          ) : status === "failed" ? (
            <XCircle size={14} className="status-icon" />
          ) : (
            <CheckCircle size={14} className="status-icon" />
          )}
          <span className="status-text">{status}</span>
        </div>
      </button>

      {isExpanded && (
        <div className="tool-call-details">
          <div className="tool-call-section">
            <div className="section-header">Arguments</div>
            <pre className="section-content">{JSON.stringify(args, null, 2)}</pre>
          </div>

          {result !== undefined && (
            <div className="tool-call-section">
              <div className="section-header">Result</div>
              <pre className="section-content">{JSON.stringify(result, null, 2)}</pre>
            </div>
          )}

          {error !== undefined && (
            <div className="tool-call-section">
              <div className="section-header">Error</div>
              <pre className="section-content">{JSON.stringify(error, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
