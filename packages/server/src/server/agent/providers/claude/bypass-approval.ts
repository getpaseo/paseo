import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

type PermissionOptions = Parameters<CanUseTool>[2];

// In bypassPermissions, Claude Code still forwards an ask when the user configured one
// (a permissions.ask rule, including managed policy, or a PreToolUse hook), when the tool
// needs an answer, or when one of its own checks fires. Bypass approves only Claude's own
// checks. A missing or unknown reason type stays with the user.
const CLAUDE_OWN_CHECK_TYPES: ReadonlySet<string> = new Set([
  "safetyCheck",
  "subcommandResults",
  "workingDir",
  "sandboxOverride",
  "mode",
  "classifier",
  "asyncAgent",
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
  const reasonType = "decisionReasonType" in options ? options.decisionReasonType : undefined;
  return typeof reasonType === "string" && CLAUDE_OWN_CHECK_TYPES.has(reasonType);
}
