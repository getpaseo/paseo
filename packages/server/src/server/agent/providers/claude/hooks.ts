import type { ClaudeOptions } from "./query.js";
import {
  formatToolResultTemporalContext,
  formatUserMessageTemporalContext,
  type TemporalClock,
} from "../../temporal-context.js";

type ClaudeHooks = NonNullable<ClaudeOptions["hooks"]>;

export function createClaudeTemporalHooks(clock: TemporalClock): ClaudeHooks {
  const toolStarts = new Map<string, number>();

  return {
    UserPromptSubmit: [
      {
        hooks: [
          async () => ({
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: formatUserMessageTemporalContext(clock),
            },
          }),
        ],
      },
    ],
    PreToolUse: [
      {
        hooks: [
          async (input, toolUseId) => {
            const callId =
              toolUseId ?? (input.hook_event_name === "PreToolUse" ? input.tool_use_id : undefined);
            if (callId) {
              toolStarts.set(callId, clock.monotonicTime());
            }
            return {};
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input, toolUseId) => {
            if (input.hook_event_name !== "PostToolUse") return {};
            const callId = toolUseId ?? input.tool_use_id;
            const startedAt = toolStarts.get(callId) ?? clock.monotonicTime();
            toolStarts.delete(callId);
            const durationMs = input.duration_ms ?? clock.monotonicTime() - startedAt;
            return {
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                additionalContext: formatToolResultTemporalContext(clock, durationMs),
              },
            };
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          async (input, toolUseId) => {
            if (input.hook_event_name !== "PostToolUseFailure") return {};
            const callId = toolUseId ?? input.tool_use_id;
            const startedAt = toolStarts.get(callId) ?? clock.monotonicTime();
            toolStarts.delete(callId);
            const durationMs = input.duration_ms ?? clock.monotonicTime() - startedAt;
            return {
              hookSpecificOutput: {
                hookEventName: "PostToolUseFailure",
                additionalContext: formatToolResultTemporalContext(clock, durationMs),
              },
            };
          },
        ],
      },
    ],
  };
}

/**
 * Combine Paseo's observation hooks with any the user configured, per event.
 *
 * Neither side wins: Claude Code runs every matcher registered for an event, so appending keeps
 * a user's hooks working while Paseo keeps observing. Assigning either one would silently drop
 * the other, and the failure would be invisible — effort would simply stop appearing.
 */
export function mergeClaudeHooks(own: ClaudeHooks, extra: unknown): ClaudeHooks {
  if (!extra || typeof extra !== "object") return own;
  const merged: ClaudeHooks = { ...own };
  for (const [event, matchers] of Object.entries(extra as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    const key = event as keyof ClaudeHooks;
    merged[key] = [...(merged[key] ?? []), ...matchers] as ClaudeHooks[typeof key];
  }
  return merged;
}
