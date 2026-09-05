import type { PiAgentMessage } from "./rpc-types.js";

const PI_SUBAGENT_CONTROL_CUSTOM_TYPES = new Set([
  "subagent-notify",
  "subagent_control_notice",
  "subagent_steering_notice",
  "subagent_supervisor_request",
  "subagent_watchdog_warning",
]);

const PI_SUBAGENT_CONTROL_TEXT_SIGNATURES = [
  /^(?:Background task|Detached foreground task) (?:completed|failed|paused|stopped): \*\*[^\n]+?\*\*(?: \([^\n)]*\))?(?:\n|$)/,
  /^(?:Background tasks|Detached foreground tasks) (?:completed|failed|paused|stopped) \(\d+\): \*\*[^\n]+\*\*(?:\n|$)/,
  /^Subagent progress update\.(?:\n|$)/,
  /^Subagent needs attention: [^\n]+(?:\n|$)/,
  /^Subagent failed: [^\n]+(?:\n|$)/,
  /^Subagent active but long-running: [^\n]+(?:\n|$)/,
  /^Subagent needs a supervisor decision\.(?:\n|$)/,
  /^Subagent requests a structured supervisor interview\.(?:\n|$)/,
];

/**
 * Pi keeps custom messages in its native session and model context. Paseo only
 * decides here whether the same message should become a visible transcript row.
 */
export function shouldProjectPiCustomMessage(
  message: Extract<PiAgentMessage, { role: "custom" }>,
  text: string,
): boolean {
  if (message.customType && PI_SUBAGENT_CONTROL_CUSTOM_TYPES.has(message.customType)) {
    return false;
  }

  return !PI_SUBAGENT_CONTROL_TEXT_SIGNATURES.some((signature) => signature.test(text));
}
