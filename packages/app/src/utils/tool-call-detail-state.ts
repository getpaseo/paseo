import type { ToolCallDetail } from "@server/server/agent/agent-sdk-types";

function hasMeaningfulUnknownValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(hasMeaningfulUnknownValue);
  }
  if (typeof value === "object") {
    return Object.values(value).some(hasMeaningfulUnknownValue);
  }
  return true;
}

export function hasMeaningfulToolCallDetail(
  detail: ToolCallDetail | undefined
): boolean {
  if (!detail) {
    return false;
  }

  switch (detail.type) {
    case "shell":
      return true;
    case "read":
      return Boolean(detail.filePath || detail.content);
    case "edit":
      return Boolean(
        detail.filePath || detail.unifiedDiff || detail.oldString || detail.newString
      );
    case "write":
      return Boolean(detail.filePath || detail.content);
    case "search":
      return detail.query.trim().length > 0;
    case "worktree_setup":
      return Boolean(detail.branchName || detail.worktreePath || detail.log);
    case "sub_agent":
      return Boolean(
        detail.subAgentType ||
          detail.description ||
          detail.log ||
          detail.actions.length > 0
      );
    case "plain_text":
      return Boolean(detail.label || detail.text);
    case "unknown":
      return (
        hasMeaningfulUnknownValue(detail.input) ||
        hasMeaningfulUnknownValue(detail.output)
      );
  }
}

export function isPendingToolCallDetail(params: {
  detail: ToolCallDetail | undefined;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  error: unknown | null | undefined;
}): boolean {
  const isRunning =
    params.status === "running" || params.status === "executing";
  return isRunning && params.error == null && !hasMeaningfulToolCallDetail(params.detail);
}
