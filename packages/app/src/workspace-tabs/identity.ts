import { normalizeWorkspaceFileLocation, workspaceFileLocationsEqual } from "@/workspace/file-open";
import type { WorkspaceDraftTabSetup, WorkspaceTabTarget } from "@/workspace-tabs/model";

export function normalizeWorkspaceTabTarget(
  value: WorkspaceTabTarget | null | undefined,
): WorkspaceTabTarget | null {
  if (!value || typeof value !== "object" || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "draft") {
    const draftId = trimNonEmpty(value.draftId);
    if (!draftId) {
      return null;
    }
    const setup = normalizeWorkspaceDraftTabSetup(value.setup);
    return setup ? { kind: "draft", draftId, setup } : { kind: "draft", draftId };
  }
  if (value.kind === "new_tab") {
    return { kind: "new_tab" };
  }
  if (value.kind === "agent") {
    const agentId = trimNonEmpty(value.agentId);
    return agentId ? { kind: "agent", agentId } : null;
  }
  if (value.kind === "provider_subagent") {
    const parentAgentId = trimNonEmpty(value.parentAgentId);
    const subagentId = trimNonEmpty(value.subagentId);
    return parentAgentId && subagentId
      ? { kind: "provider_subagent", parentAgentId, subagentId }
      : null;
  }
  if (value.kind === "file") {
    return normalizeFileTabTarget(value);
  }
  if (value.kind === "working_diff") {
    return normalizeWorkingDiffTabTarget(value);
  }
  if (value.kind === "plugin") {
    return normalizePluginTabTarget(value);
  }
  return normalizeSimpleWorkspaceTabTarget(value);
}

function normalizeSimpleWorkspaceTabTarget(value: WorkspaceTabTarget): WorkspaceTabTarget | null {
  switch (value.kind) {
    case "agent": {
      const agentId = trimNonEmpty(value.agentId);
      return agentId ? { kind: "agent", agentId } : null;
    }
    case "terminal": {
      const terminalId = trimNonEmpty(value.terminalId);
      return terminalId ? { kind: "terminal", terminalId } : null;
    }
    case "browser": {
      const browserId = trimNonEmpty(value.browserId);
      return browserId ? { kind: "browser", browserId } : null;
    }
    case "files":
    case "pull_request":
      return { kind: value.kind };
    case "setup": {
      const workspaceId = trimNonEmpty(value.workspaceId);
      return workspaceId ? { kind: "setup", workspaceId } : null;
    }
    case "commit_diff": {
      const sha = trimNonEmpty(value.sha);
      return sha ? { kind: "commit_diff", sha } : null;
    }
    default:
      return null;
  }
}

export function normalizeWorkspaceDraftTabSetup(
  value: unknown,
): WorkspaceDraftTabSetup | undefined {
  const record = isPlainRecord(value) ? value : null;
  if (!record) {
    return undefined;
  }
  const provider = trimNonEmpty(typeof record.provider === "string" ? record.provider : null);
  const cwd = trimNonEmpty(typeof record.cwd === "string" ? record.cwd : null);
  if (!provider || !cwd) {
    return undefined;
  }
  return {
    provider,
    cwd,
    modeId: trimOptionalString(typeof record.modeId === "string" ? record.modeId : null),
    model: trimOptionalString(typeof record.model === "string" ? record.model : null),
    thinkingOptionId: trimOptionalString(
      typeof record.thinkingOptionId === "string" ? record.thinkingOptionId : null,
    ),
    featureValues: isPlainRecord(record.featureValues) ? { ...record.featureValues } : {},
  };
}

export function workspaceTabTargetsEqual(
  left: WorkspaceTabTarget,
  right: WorkspaceTabTarget,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "draft" && right.kind === "draft") {
    return left.draftId === right.draftId && workspaceDraftTabSetupsEqual(left.setup, right.setup);
  }
  if (left.kind === "agent" && right.kind === "agent") {
    return left.agentId === right.agentId;
  }
  if (left.kind === "provider_subagent" && right.kind === "provider_subagent") {
    return left.parentAgentId === right.parentAgentId && left.subagentId === right.subagentId;
  }
  if (left.kind === "terminal" && right.kind === "terminal") {
    return left.terminalId === right.terminalId;
  }
  if (left.kind === "plugin" && right.kind === "plugin") {
    return (
      left.pluginId === right.pluginId &&
      left.panelId === right.panelId &&
      left.context === right.context &&
      (left.context === "workspace" ||
        (right.context === "agent" && left.agentId === right.agentId))
    );
  }
  return secondaryWorkspaceTabTargetsEqual(left, right);
}

function secondaryWorkspaceTabTargetsEqual(
  left: WorkspaceTabTarget,
  right: WorkspaceTabTarget,
): boolean {
  if (left.kind === "browser" && right.kind === "browser") {
    return left.browserId === right.browserId;
  }
  if (left.kind === "file" && right.kind === "file") {
    return workspaceFileLocationsEqual(left, right);
  }
  if (left.kind === "working_diff" && right.kind === "working_diff") {
    return left.focusPath === right.focusPath && left.focusRequestId === right.focusRequestId;
  }
  if (left.kind === "files" && right.kind === "files") {
    return true;
  }
  if (left.kind === "pull_request" && right.kind === "pull_request") {
    return true;
  }
  if (left.kind === "setup" && right.kind === "setup") {
    return left.workspaceId === right.workspaceId;
  }
  if (left.kind === "commit_diff" && right.kind === "commit_diff") {
    return left.sha === right.sha;
  }
  return false;
}

function workspaceDraftTabSetupsEqual(
  left: WorkspaceDraftTabSetup | undefined,
  right: WorkspaceDraftTabSetup | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.provider === right.provider &&
    left.cwd === right.cwd &&
    left.modeId === right.modeId &&
    left.model === right.model &&
    left.thinkingOptionId === right.thinkingOptionId &&
    recordsShallowEqual(left.featureValues, right.featureValues)
  );
}

function recordsShallowEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !Object.is(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

export function buildDeterministicWorkspaceTabId(target: WorkspaceTabTarget): string {
  if (target.kind === "new_tab") {
    throw new Error("New tabs do not have deterministic target identities");
  }
  if (target.kind === "draft") {
    return target.draftId;
  }
  if (target.kind === "agent") {
    return `agent_${target.agentId}`;
  }
  if (target.kind === "provider_subagent") {
    return `provider_subagent_${target.parentAgentId.length}_${target.parentAgentId}_${target.subagentId.length}_${target.subagentId}`;
  }
  if (target.kind === "terminal") {
    return `terminal_${target.terminalId}`;
  }
  if (target.kind === "browser") {
    return `browser_${target.browserId}`;
  }
  if (target.kind === "setup") {
    return `setup_${target.workspaceId}`;
  }
  if (target.kind === "commit_diff") {
    return `commit_diff_${target.sha}`;
  }
  if (target.kind === "working_diff") {
    return "working_diff";
  }
  if (target.kind === "files" || target.kind === "pull_request") {
    return target.kind;
  }
  if (target.kind === "plugin") {
    const identity = `${target.pluginId.length}_${target.pluginId}_${target.panelId.length}_${target.panelId}`;
    return target.context === "workspace"
      ? `plugin_workspace_${identity}`
      : `plugin_agent_${identity}_${target.agentId.length}_${target.agentId}`;
  }
  return `file_${target.path}`;
}

function normalizePluginTabTarget(
  value: Extract<WorkspaceTabTarget, { kind: "plugin" }>,
): WorkspaceTabTarget | null {
  const pluginId = trimNonEmpty(value.pluginId);
  const panelId = trimNonEmpty(value.panelId);
  if (!pluginId || !panelId) return null;
  if (value.context === "workspace") {
    return { kind: "plugin", pluginId, panelId, context: "workspace" };
  }
  const agentId = trimNonEmpty(value.agentId);
  return agentId ? { kind: "plugin", pluginId, panelId, context: "agent", agentId } : null;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeFileTabTarget(
  value: Extract<WorkspaceTabTarget, { kind: "file" }>,
): WorkspaceTabTarget | null {
  const location = normalizeWorkspaceFileLocation(value);
  return location ? { kind: "file", ...location } : null;
}

function normalizeWorkingDiffTabTarget(
  value: Extract<WorkspaceTabTarget, { kind: "working_diff" }>,
): WorkspaceTabTarget | null {
  const focusPath = trimNonEmpty(value.focusPath)?.replace(/\\/g, "/") ?? null;
  const focusRequestId = normalizePositiveInteger(value.focusRequestId);
  return {
    kind: "working_diff" as const,
    ...(focusPath ? { focusPath } : {}),
    ...(focusRequestId ? { focusRequestId } : {}),
  };
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function trimOptionalString(value: string | null | undefined): string | null {
  return value == null ? null : trimNonEmpty(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
