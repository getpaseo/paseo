import { describe, expect, it, vi } from "vitest";

import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";

import type { TemporalClock } from "../../temporal-context.js";
import { createClaudeTemporalHooks, mergeClaudeHooks } from "./hooks.js";

const hookBase = {
  session_id: "session-1",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/tmp/project",
};

function temporalClock(monotonicTimes: number[] = [100, 350]): TemporalClock {
  let wallTimeCall = 0;
  let monotonicCall = 0;
  const wallTimes = [new Date("2026-09-06T18:32:18.421Z"), new Date("2026-09-06T18:32:19.421Z")];
  return {
    wallTime: () => wallTimes[Math.min(wallTimeCall++, wallTimes.length - 1)]!,
    monotonicTime: () => monotonicTimes[Math.min(monotonicCall++, monotonicTimes.length - 1)]!,
    timeZone: "America/New_York",
  };
}

function firstHook(
  hooks: ReturnType<typeof createClaudeTemporalHooks>,
  event: keyof ReturnType<typeof createClaudeTemporalHooks>,
): HookCallback {
  const hook = hooks[event]?.[0]?.hooks[0];
  if (!hook) throw new Error(`Missing ${event} hook`);
  return hook;
}

async function invokeHook(hook: HookCallback, input: HookInput, toolUseId?: string) {
  return hook(input, toolUseId, { signal: new AbortController().signal });
}

describe("mergeClaudeHooks", () => {
  const own = { PreToolUse: [{ hooks: [vi.fn()] }] } as never;

  it("keeps Paseo's hooks when the user configured none", () => {
    expect(mergeClaudeHooks(own, undefined)).toEqual(own);
    expect(mergeClaudeHooks(own, null)).toEqual(own);
  });

  it("appends user hooks for the same event instead of replacing them", () => {
    const userHook = vi.fn();
    const merged = mergeClaudeHooks(own, { PreToolUse: [{ hooks: [userHook] }] }) as {
      PreToolUse: unknown[];
    };
    // Both must survive: dropping Paseo's would silently stop effort being observed, and
    // dropping the user's would break their configuration.
    expect(merged.PreToolUse).toHaveLength(2);
  });

  it("carries through events Paseo does not register", () => {
    const merged = mergeClaudeHooks(own, { SessionStart: [{ hooks: [vi.fn()] }] }) as Record<
      string,
      unknown[]
    >;
    expect(merged.SessionStart).toHaveLength(1);
    expect(merged.PreToolUse).toHaveLength(1);
  });

  it("ignores malformed entries rather than throwing", () => {
    expect(mergeClaudeHooks(own, { PreToolUse: "not-an-array" })).toEqual(own);
    expect(mergeClaudeHooks(own, "nonsense")).toEqual(own);
  });
});

describe("Claude temporal hooks", () => {
  it("adds trusted receipt time to every user prompt", async () => {
    const hooks = createClaudeTemporalHooks(temporalClock());

    await expect(
      invokeHook(firstHook(hooks, "UserPromptSubmit"), {
        ...hookBase,
        hook_event_name: "UserPromptSubmit",
        prompt: "hello",
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          '<paseo_temporal_context kind="user_message" received_at="2026-09-06T18:32:18.421Z" timezone="America/New_York" />',
      },
    });
  });

  it("uses Claude's execution-only duration for successful tool results", async () => {
    const hooks = createClaudeTemporalHooks(temporalClock());
    await invokeHook(
      firstHook(hooks, "PreToolUse"),
      {
        ...hookBase,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "tool-1",
      },
      "tool-1",
    );

    await expect(
      invokeHook(
        firstHook(hooks, "PostToolUse"),
        {
          ...hookBase,
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: {},
          tool_response: "done",
          tool_use_id: "tool-1",
          duration_ms: 1247,
        },
        "tool-1",
      ),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          '<paseo_temporal_context kind="tool_result" completed_at="2026-09-06T18:32:18.421Z" timezone="America/New_York" duration_ms="1247" />',
      },
    });
  });

  it("falls back to its monotonic clock for failed tools without SDK duration", async () => {
    const hooks = createClaudeTemporalHooks(temporalClock([100, 350]));
    await invokeHook(
      firstHook(hooks, "PreToolUse"),
      {
        ...hookBase,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "tool-2",
      },
      "tool-2",
    );

    const output = await invokeHook(
      firstHook(hooks, "PostToolUseFailure"),
      {
        ...hookBase,
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "tool-2",
        error: "failed",
      },
      "tool-2",
    );

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext:
          '<paseo_temporal_context kind="tool_result" completed_at="2026-09-06T18:32:18.421Z" timezone="America/New_York" duration_ms="250" />',
      },
    });
  });

  it("keeps concurrent tool durations paired with their call IDs", async () => {
    const hooks = createClaudeTemporalHooks(temporalClock([100, 200, 260, 400]));
    const preToolUse = firstHook(hooks, "PreToolUse");
    const postToolUse = firstHook(hooks, "PostToolUse");

    for (const toolUseId of ["tool-a", "tool-b"]) {
      await invokeHook(
        preToolUse,
        {
          ...hookBase,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: {},
          tool_use_id: toolUseId,
        },
        toolUseId,
      );
    }

    const toolB = await invokeHook(postToolUse, {
      ...hookBase,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: {},
      tool_response: "done",
      tool_use_id: "tool-b",
    });
    const toolA = await invokeHook(postToolUse, {
      ...hookBase,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: {},
      tool_response: "done",
      tool_use_id: "tool-a",
    });

    expect(toolB).toMatchObject({
      hookSpecificOutput: { additionalContext: expect.stringContaining('duration_ms="60"') },
    });
    expect(toolA).toMatchObject({
      hookSpecificOutput: { additionalContext: expect.stringContaining('duration_ms="300"') },
    });
  });
});
