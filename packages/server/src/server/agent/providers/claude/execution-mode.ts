import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/** The permission choice the user made. Plan is tracked beside it, so planning never replaces it. */
export type ClaudeAccessMode = "default" | "acceptEdits" | "auto" | "bypassPermissions";

export interface ClaudeExecutionMode {
  accessMode: ClaudeAccessMode;
  isPlanMode: boolean;
}

export const CLAUDE_PLAN_MODE_ID = "plan";

export function isClaudeAccessMode(value: unknown): value is ClaudeAccessMode {
  return (
    value === "default" ||
    value === "acceptEdits" ||
    value === "auto" ||
    value === "bypassPermissions"
  );
}

/** `defaultAccessMode` is Claude's default mode where this session runs, such as Auto. */
export function resolveClaudeExecutionMode(
  config: { modeId?: string; featureValues?: Record<string, unknown> },
  defaultAccessMode: ClaudeAccessMode,
): ClaudeExecutionMode {
  const planModeValue = config.featureValues?.plan_mode;
  // COMPAT(claudePlanMode): added in v0.11.0, remove after 2027-04-05 once stored agents and
  // clients send plan_mode. Agents saved before the split only kept modeId "plan" and lost the
  // access mode, so they resume planning in Claude's default access mode.
  const isLegacyPlan = config.modeId === CLAUDE_PLAN_MODE_ID;
  let accessMode: ClaudeAccessMode = "default";
  if (isClaudeAccessMode(config.modeId)) {
    accessMode = config.modeId;
  } else if (isLegacyPlan) {
    accessMode = defaultAccessMode;
  }
  return {
    accessMode,
    isPlanMode: typeof planModeValue === "boolean" ? planModeValue : isLegacyPlan,
  };
}

/** Claude Code takes a single permission mode; Plan wins while it is on. */
export function toClaudeSdkPermissionMode(mode: ClaudeExecutionMode): PermissionMode {
  return mode.isPlanMode ? CLAUDE_PLAN_MODE_ID : mode.accessMode;
}

/** Approving a plan leaves Plan. Implement with Bypass is only offered while Bypass is kept. */
export function approveClaudePlan(
  mode: ClaudeExecutionMode,
  actionId: string | undefined,
): ClaudeExecutionMode {
  const resumeBypass = actionId === "implement_resume" && mode.accessMode === "bypassPermissions";
  return { accessMode: resumeBypass ? "bypassPermissions" : "acceptEdits", isPlanMode: false };
}

/** Selecting the "plan" mode turns Plan on; any other mode changes the access mode Plan keeps. */
export function selectClaudeMode(mode: ClaudeExecutionMode, modeId: string): ClaudeExecutionMode {
  if (modeId === CLAUDE_PLAN_MODE_ID) {
    return { ...mode, isPlanMode: true };
  }
  if (!isClaudeAccessMode(modeId)) {
    throw new Error(`Invalid Claude access mode '${modeId}'`);
  }
  return { ...mode, accessMode: modeId };
}

/**
 * Claude Code reports its live mode on init and status messages, including after it calls
 * EnterPlanMode itself. A reported plan keeps the access mode; any other mode ends Plan.
 */
export function reconcileClaudeSdkPermissionMode(
  mode: ClaudeExecutionMode,
  sdkMode: unknown,
): ClaudeExecutionMode {
  if (sdkMode === CLAUDE_PLAN_MODE_ID) {
    return mode.isPlanMode ? mode : { ...mode, isPlanMode: true };
  }
  if (!isClaudeAccessMode(sdkMode) || (!mode.isPlanMode && mode.accessMode === sdkMode)) {
    return mode;
  }
  return { accessMode: sdkMode, isPlanMode: false };
}

/**
 * Interactive Claude Code approves the asks plan mode raises when the session can bypass
 * permissions. It skips that for SDK hosts, so Paseo answers them for an agent in Bypass plus Plan.
 */
export function approvesPlanModeAsks(mode: ClaudeExecutionMode): boolean {
  return mode.isPlanMode && mode.accessMode === "bypassPermissions";
}
