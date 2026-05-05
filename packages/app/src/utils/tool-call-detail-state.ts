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

function hasMeaningfulSearchDetail(detail: Extract<ToolCallDetail, { type: "search" }>): boolean {
  if (detail.query.trim().length > 0) return true;
  if (detail.content) return true;
  if (detail.filePaths && detail.filePaths.length > 0) return true;
  if (detail.webResults && detail.webResults.length > 0) return true;
  if (detail.annotations && detail.annotations.length > 0) return true;
  return false;
}

function hasMeaningfulReadLikeDetail(detail: { filePath?: unknown; content?: unknown }): boolean {
  return Boolean(detail.filePath || detail.content);
}

function hasMeaningfulEditDetail(detail: Extract<ToolCallDetail, { type: "edit" }>): boolean {
  return Boolean(detail.filePath || detail.unifiedDiff || detail.oldString || detail.newString);
}

function hasMeaningfulFetchDetail(detail: Extract<ToolCallDetail, { type: "fetch" }>): boolean {
  return Boolean(detail.url || detail.result || detail.codeText);
}

function hasMeaningfulWorktreeSetupDetail(
  detail: Extract<ToolCallDetail, { type: "worktree_setup" }>,
): boolean {
  return Boolean(detail.branchName || detail.worktreePath || detail.log);
}

function hasMeaningfulSubAgentDetail(
  detail: Extract<ToolCallDetail, { type: "sub_agent" }>,
): boolean {
  return Boolean(detail.subAgentType || detail.description || detail.log);
}

function hasMeaningfulPlainTextDetail(
  detail: Extract<ToolCallDetail, { type: "plain_text" }>,
): boolean {
  return Boolean(detail.label || detail.text);
}

function hasMeaningfulUnknownDetail(detail: Extract<ToolCallDetail, { type: "unknown" }>): boolean {
  return hasMeaningfulUnknownValue(detail.input) || hasMeaningfulUnknownValue(detail.output);
}

export function hasMeaningfulToolCallDetail(detail: ToolCallDetail | undefined): boolean {
  if (!detail) {
    return false;
  }

  switch (detail.type) {
    case "shell":
      return true;
    case "read":
      return hasMeaningfulReadLikeDetail(detail);
    case "edit":
      return hasMeaningfulEditDetail(detail);
    case "write":
      return hasMeaningfulReadLikeDetail(detail);
    case "search":
      return hasMeaningfulSearchDetail(detail);
    case "fetch":
      return hasMeaningfulFetchDetail(detail);
    case "worktree_setup":
      return hasMeaningfulWorktreeSetupDetail(detail);
    case "sub_agent":
      return hasMeaningfulSubAgentDetail(detail);
    case "plain_text":
      return hasMeaningfulPlainTextDetail(detail);
    case "plan":
      return detail.text.trim().length > 0;
    case "unknown":
      return hasMeaningfulUnknownDetail(detail);
  }
}

export function isPendingToolCallDetail(params: {
  detail: ToolCallDetail | undefined;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  error: unknown;
}): boolean {
  const isRunning = params.status === "running" || params.status === "executing";
  return isRunning && params.error == null && !hasMeaningfulToolCallDetail(params.detail);
}
