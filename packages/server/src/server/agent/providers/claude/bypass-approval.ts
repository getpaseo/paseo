import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

type PermissionOptions = Parameters<CanUseTool>[2];

// In bypassPermissions, Claude Code still forwards an ask when the user configured one
// (a permissions.ask rule, including managed policy, or a PreToolUse hook), when the tool
// needs an answer, or when one of its own checks fires. Bypass approves only Claude's own
// checks. A missing or unknown reason type stays with the user.
// `subcommandResults` is left out: a compound or piped command uses it as a container,
// including when a user's ask rule matched one of its parts. `sandboxOverride` is left
// out: in Bypass, Claude Code forwards it only when the user's read block or hook raised it.
const CLAUDE_OWN_CHECK_TYPES: ReadonlySet<string> = new Set([
  "safetyCheck",
  "workingDir",
  "mode",
  "classifier",
  "asyncAgent",
]);

// Settings the user or organization chose, which Claude Code reports under its own types:
// permissions.blockReadsOutsideWorkingDirectories, and an organization's ask limit.
const CONFIGURED_ASK_CODES: ReadonlySet<string> = new Set([
  "outside_reads_blocked",
  "org_ask_ceiling",
]);

const QUESTION_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

export function bypassApprovesAsk(toolName: string, options: PermissionOptions): boolean {
  if (QUESTION_TOOLS.has(toolName) || options.matchedAskRule) {
    return false;
  }
  // The SDK forwards these from Claude Code without declaring them on CanUseTool.
  if ("requiresUserInteraction" in options && options.requiresUserInteraction === true) {
    return false;
  }
  const reasonCode = "decisionReasonCode" in options ? options.decisionReasonCode : undefined;
  if (typeof reasonCode === "string" && CONFIGURED_ASK_CODES.has(reasonCode)) {
    return false;
  }
  const reasonType = "decisionReasonType" in options ? options.decisionReasonType : undefined;
  return typeof reasonType === "string" && CLAUDE_OWN_CHECK_TYPES.has(reasonType);
}
