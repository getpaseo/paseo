/**
 * Since Claude Code 2.1.271, a subagent in auto mode delivers its report to its caller through a
 * `SubagentHandback` tool call instead of its final text. The report is the subagent's final
 * message, so Paseo shows it as one and hides the call and its acknowledgement.
 */
const SUBAGENT_HANDBACK_TOOL_NAME = "SubagentHandback";

export interface ClaudeSubagentHandback {
  callId: string;
  /** Null while the call is still streaming its input. */
  report: string | null;
}

export function isClaudeSubagentHandbackToolName(name: unknown): boolean {
  return name === SUBAGENT_HANDBACK_TOOL_NAME;
}

export function readClaudeSubagentHandback(block: {
  type: string;
  [key: string]: unknown;
}): ClaudeSubagentHandback | null {
  if (block.type !== "tool_use" || !isClaudeSubagentHandbackToolName(block.name)) return null;
  if (typeof block.id !== "string" || block.id.length === 0) return null;
  const input = block.input as { message?: unknown } | null | undefined;
  const report = typeof input?.message === "string" ? input.message.trim() : "";
  return { callId: block.id, report: report.length > 0 ? report : null };
}
