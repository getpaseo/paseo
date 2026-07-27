import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { ClaudeTaskProtocolSource } from "./live-source.js";

// Shapes copied from real wire output (Claude Code 2.1.220) rather than the type declarations,
// so the fixtures stay honest about what actually arrives.
function taskStarted(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "system",
    subtype: "task_started",
    task_id: "a1730a6215e1f5cf6",
    tool_use_id: "toolu_01DgLoPMW9",
    description: "Summarize hover and unistyles docs",
    subagent_type: "general-purpose",
    task_type: "local_agent",
    ...overrides,
  } as unknown as SDKMessage;
}

function taskUpdated(status: string, taskId = "a1730a6215e1f5cf6"): SDKMessage {
  return {
    type: "system",
    subtype: "task_updated",
    task_id: taskId,
    patch: { status, end_time: 1785117455676 },
  } as unknown as SDKMessage;
}

function taskNotification(status: string, taskId = "a1730a6215e1f5cf6"): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: "toolu_01DgLoPMW9",
    status,
    output_file: "/tmp/x.output",
    summary: "done",
  } as unknown as SDKMessage;
}

describe("ClaudeTaskProtocolSource", () => {
  it("declares a subagent from its announcement, keyed by the Task tool_use id", () => {
    const source = new ClaudeTaskProtocolSource();

    expect(source.observe(taskStarted())).toEqual([
      {
        kind: "declared",
        id: "toolu_01DgLoPMW9",
        toolCallId: "toolu_01DgLoPMW9",
        title: "general-purpose",
        description: "Summarize hover and unistyles docs",
      },
    ]);
  });

  it("prefers the name the Task call gave over the agent type", () => {
    // The replay source titles a subagent `input.name ?? subagent_type`. Live reads the same
    // field from the same Task call, so one subagent is named identically on both paths.
    const source = new ClaudeTaskProtocolSource({
      getToolInput: (toolUseId) =>
        toolUseId === "toolu_01DgLoPMW9" ? { name: "docs-scout", subagent_type: "Explore" } : null,
    });

    expect(source.observe(taskStarted({ subagent_type: "Explore" }))[0]).toMatchObject({
      kind: "declared",
      title: "docs-scout",
    });
  });

  it("falls back to the agent type when the Task call named nothing", () => {
    const source = new ClaudeTaskProtocolSource({ getToolInput: () => ({ description: "x" }) });
    expect(source.observe(taskStarted())[0]).toMatchObject({ title: "general-purpose" });
  });

  it("routes a status update through the task_id it learned at declaration", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());

    // task_updated carries no tool_use_id — the mapping is the only way to route it.
    expect(source.observe(taskUpdated("completed"))).toEqual([
      { kind: "status", id: "toolu_01DgLoPMW9", status: "completed" },
    ]);
  });

  it("does not re-announce a status that already holds", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    source.observe(taskUpdated("completed"));

    // task_updated and task_notification arrive in the same millisecond on the real wire.
    expect(source.observe(taskNotification("completed"))).toEqual([]);
  });

  it("treats a killed or stopped task as canceled, not failed", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    expect(source.observe(taskUpdated("killed"))).toEqual([
      { kind: "status", id: "toolu_01DgLoPMW9", status: "canceled" },
    ]);
  });

  it("keeps a paused task running, since the descriptor has no paused state", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    source.observe(taskUpdated("completed"));
    expect(source.observe(taskUpdated("paused"))).toEqual([
      { kind: "status", id: "toolu_01DgLoPMW9", status: "running" },
    ]);
  });

  it("ignores tasks that carry no tool_use id", () => {
    const source = new ClaudeTaskProtocolSource();
    expect(source.observe(taskStarted({ tool_use_id: undefined }))).toEqual([]);
    expect(source.isActive).toBe(false);
  });

  it("ignores a backgrounded shell command", () => {
    const source = new ClaudeTaskProtocolSource();
    // Real wire shape: a backgrounded Bash announces with a tool_use_id but no subagent_type,
    // so filtering on the id alone would put `sleep 20` in the subagents track.
    expect(
      source.observe(
        taskStarted({
          task_id: "b51skux0z",
          tool_use_id: "toolu_01MgVdcGPYnqE8cJQuccFtkU",
          task_type: "local_bash",
          subagent_type: undefined,
          description: "Sleep 20 seconds in background",
        }),
      ),
    ).toEqual([]);
    expect(source.isActive).toBe(false);
  });

  it("ignores a workflow run", () => {
    const source = new ClaudeTaskProtocolSource();
    expect(
      source.observe(taskStarted({ task_type: "local_workflow", subagent_type: undefined })),
    ).toEqual([]);
  });

  it("accepts a subagent from a release that predates task_type", () => {
    const source = new ClaudeTaskProtocolSource();
    const observations = source.observe(taskStarted({ task_type: undefined }));
    expect(observations[0]).toMatchObject({ kind: "declared", title: "general-purpose" });
  });

  it("ignores an untyped task with no subagent type", () => {
    const source = new ClaudeTaskProtocolSource();
    expect(source.observe(taskStarted({ task_type: undefined, subagent_type: undefined }))).toEqual(
      [],
    );
  });

  it("opens the child timeline with the prompt it was given", () => {
    const source = new ClaudeTaskProtocolSource();
    const observations = source.observe(
      taskStarted({ prompt: "Reply with just the word: banana" }),
    );

    expect(observations[1]).toEqual({
      kind: "timeline",
      id: "toolu_01DgLoPMW9",
      item: { type: "user_message", text: "Reply with just the word: banana" },
    });
  });

  it("declares without a timeline item when no prompt was announced", () => {
    const source = new ClaudeTaskProtocolSource();
    expect(source.observe(taskStarted())).toHaveLength(1);
  });

  it("ignores ambient housekeeping tasks", () => {
    const source = new ClaudeTaskProtocolSource();
    expect(source.observe(taskStarted({ skip_transcript: true }))).toEqual([]);
    expect(source.isActive).toBe(false);
  });

  it("routes concurrent subagents independently", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    source.observe(
      taskStarted({
        task_id: "a88cdd22e38fd1dcf",
        tool_use_id: "toolu_01GMd4ob4m",
        description: "Summarize forms and design docs",
      }),
    );

    expect(source.observe(taskUpdated("completed", "a88cdd22e38fd1dcf"))).toEqual([
      { kind: "status", id: "toolu_01GMd4ob4m", status: "completed" },
    ]);
    expect(source.observe(taskUpdated("failed", "a1730a6215e1f5cf6"))).toEqual([
      { kind: "status", id: "toolu_01DgLoPMW9", status: "failed" },
    ]);
  });

  it("drops a status for a task it never saw declared", () => {
    const source = new ClaudeTaskProtocolSource();
    expect(source.observe(taskUpdated("completed", "unknown-task"))).toEqual([]);
  });

  it("does not readmit a filtered task through its notification", () => {
    const source = new ClaudeTaskProtocolSource();
    // A backgrounded shell is filtered at declaration, but it still gets a task_notification
    // carrying a tool_use_id. Routing status off that id would recreate the descriptor with a
    // status and no identity — a nameless row in the subagents track.
    source.observe(
      taskStarted({
        task_id: "b51skux0z",
        tool_use_id: "toolu_01MgVdcGPYnqE8cJQuccFtkU",
        task_type: "local_bash",
        subagent_type: undefined,
      }),
    );

    expect(source.observe(taskNotification("completed", "b51skux0z"))).toEqual([]);
  });

  it("drops a notification for a task it never declared", () => {
    const source = new ClaudeTaskProtocolSource();
    expect(source.observe(taskNotification("failed", "unknown-task"))).toEqual([]);
  });

  it("reports inactivity until a task is announced, for older CLIs", () => {
    const source = new ClaudeTaskProtocolSource();
    expect(source.isActive).toBe(false);
    source.observe(taskStarted());
    expect(source.isActive).toBe(true);
    source.reset();
    expect(source.isActive).toBe(false);
  });

  it("cancels the foreground subagents a canceled turn was running", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());

    expect(source.cancelRunningForegroundTasks()).toEqual([
      { kind: "status", id: "toolu_01DgLoPMW9", status: "canceled" },
    ]);
    // Idempotent: the child is no longer running, so a second cancellation says nothing.
    expect(source.cancelRunningForegroundTasks()).toEqual([]);
  });

  it("leaves an already-settled subagent alone when the turn is canceled", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    source.observe(taskUpdated("completed"));

    expect(source.cancelRunningForegroundTasks()).toEqual([]);
  });

  it("does not cancel a backgrounded subagent, which outlives the turn", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    source.observe({
      type: "system",
      subtype: "task_updated",
      task_id: "a1730a6215e1f5cf6",
      patch: { is_backgrounded: true },
    } as unknown as SDKMessage);

    expect(source.cancelRunningForegroundTasks()).toEqual([]);
  });

  it("still routes a backgrounded subagent that settles after the interrupt", () => {
    // The headline case: interrupt, continue, and the child that was told to outlive the turn
    // reports completion later. Wiping the routing table on cancel drops this on the floor and
    // leaves the row spinning forever.
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    source.observe({
      type: "system",
      subtype: "task_updated",
      task_id: "a1730a6215e1f5cf6",
      patch: { is_backgrounded: true },
    } as unknown as SDKMessage);
    source.cancelRunningForegroundTasks();

    expect(source.observe(taskNotification("completed"))).toEqual([
      { kind: "status", id: "toolu_01DgLoPMW9", status: "completed" },
    ]);
    expect(source.isActive).toBe(true);
  });

  it("lets a late notification correct a cancellation it guessed wrong", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    source.cancelRunningForegroundTasks();

    expect(source.observe(taskNotification("completed"))).toEqual([
      { kind: "status", id: "toolu_01DgLoPMW9", status: "completed" },
    ]);
  });

  it("ignores unrelated system messages", () => {
    const source = new ClaudeTaskProtocolSource();
    expect(
      source.observe({ type: "system", subtype: "init", model: "opus" } as unknown as SDKMessage),
    ).toEqual([]);
  });
});

describe("ClaudeTaskProtocolSource usage and runtime", () => {
  function taskProgress(usage: Record<string, number>, taskId = "a1730a6215e1f5cf6"): SDKMessage {
    return {
      type: "system",
      subtype: "task_progress",
      task_id: taskId,
      usage,
      last_tool_name: "Read",
    } as unknown as SDKMessage;
  }

  function assistantFrame(model: string): SDKMessage {
    return { type: "assistant", message: { model, content: [] } } as unknown as SDKMessage;
  }

  it("reports usage as the child works", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    // Real shape: task_progress fires once per tool use, not on a timer.
    expect(
      source.observe(taskProgress({ total_tokens: 16484, tool_uses: 1, duration_ms: 2474 })),
    ).toEqual([
      {
        kind: "usage",
        id: "toolu_01DgLoPMW9",
        usage: { totalTokens: 16484, toolUses: 1, durationMs: 2474 },
      },
    ]);
  });

  it("reports terminal usage and status together", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    const observations = source.observe({
      type: "system",
      subtype: "task_notification",
      task_id: "a1730a6215e1f5cf6",
      tool_use_id: "toolu_01DgLoPMW9",
      status: "completed",
      usage: { total_tokens: 32271, tool_uses: 2, duration_ms: 10934 },
    } as unknown as SDKMessage);

    expect(observations).toEqual([
      {
        kind: "usage",
        id: "toolu_01DgLoPMW9",
        usage: { totalTokens: 32271, toolUses: 2, durationMs: 10934 },
      },
      { kind: "status", id: "toolu_01DgLoPMW9", status: "completed" },
    ]);
  });

  it("ignores usage for a task it never declared", () => {
    const source = new ClaudeTaskProtocolSource();
    expect(source.observe(taskProgress({ total_tokens: 1 }, "b51skux0z"))).toEqual([]);
  });

  it("reads the model off the child's own frames", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    expect(
      source.observeSidechainFrame(assistantFrame("claude-opus-5"), "toolu_01DgLoPMW9"),
    ).toEqual([{ kind: "runtime", id: "toolu_01DgLoPMW9", model: "claude-opus-5" }]);
  });

  it("re-reports only when the model actually changes", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    source.observeSidechainFrame(assistantFrame("claude-opus-5"), "toolu_01DgLoPMW9");
    // A dated alias is the same model; a mid-flight fallback is not.
    expect(
      source.observeSidechainFrame(assistantFrame("claude-opus-5-20260724"), "toolu_01DgLoPMW9"),
    ).toEqual([]);
    expect(
      source.observeSidechainFrame(assistantFrame("claude-sonnet-5"), "toolu_01DgLoPMW9"),
    ).toEqual([{ kind: "runtime", id: "toolu_01DgLoPMW9", model: "claude-sonnet-5" }]);
  });

  it("never reports a placeholder model", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    expect(source.observeSidechainFrame(assistantFrame("<synthetic>"), "toolu_01DgLoPMW9")).toEqual(
      [],
    );
  });

  it("ignores a frame from a task it never declared", () => {
    // A filtered task still emits frames carrying its tool_use id. Reporting a model for one
    // would create a descriptor the declaration filter deliberately refused — with no title and
    // a defaulted "running" status, which the track renders as a nameless row that never ends.
    const source = new ClaudeTaskProtocolSource();
    source.observe(
      taskStarted({
        task_id: "b51skux0z",
        tool_use_id: "toolu_01MgVdcGPYnqE8cJQuccFtkU",
        task_type: "local_bash",
        subagent_type: undefined,
      }),
    );

    expect(
      source.observeSidechainFrame(
        assistantFrame("claude-opus-5"),
        "toolu_01MgVdcGPYnqE8cJQuccFtkU",
      ),
    ).toEqual([]);
    expect(source.isDeclared("toolu_01MgVdcGPYnqE8cJQuccFtkU")).toBe(false);
  });

  it("never reports effort, which the live stream does not carry", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    const all = [
      ...source.observe(taskProgress({ total_tokens: 1 })),
      ...source.observeSidechainFrame(assistantFrame("claude-opus-5"), "toolu_01DgLoPMW9"),
    ];
    expect(all.some((o) => "effort" in o && o.effort !== undefined)).toBe(false);
  });
});

describe("ClaudeTaskProtocolSource effort from hooks", () => {
  // Real hook shapes (Claude Code 2.1.220): agent_id equals task_started's task_id, and
  // effort.level is the ACTIVE level after any silent downgrade.
  function hook(overrides: Record<string, unknown> = {}) {
    return {
      agent_id: "a1730a6215e1f5cf6",
      agent_type: "general-purpose",
      effort: { level: "high" },
      ...overrides,
    };
  }

  it("reports effort for a declared subagent, routed by agent_id", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    expect(source.observeHook(hook())).toEqual([
      { kind: "runtime", id: "toolu_01DgLoPMW9", effort: "high" },
    ]);
  });

  it("does not re-report an unchanged effort", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    source.observeHook(hook());
    // PreToolUse and PostToolUse both fire on every tool use.
    expect(source.observeHook(hook())).toEqual([]);
  });

  it("reports a downgrade when the level actually changes", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    source.observeHook(hook());
    expect(source.observeHook(hook({ effort: { level: "medium" } }))).toEqual([
      { kind: "runtime", id: "toolu_01DgLoPMW9", effort: "medium" },
    ]);
  });

  it("ignores a hook from the parent turn", () => {
    // Stop fires with effort but no agent_id: that is the parent, not a child.
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    expect(source.observeHook(hook({ agent_id: undefined }))).toEqual([]);
  });

  it("ignores a hook for a subagent it never declared", () => {
    const source = new ClaudeTaskProtocolSource();
    expect(source.observeHook(hook())).toEqual([]);
  });

  it("ignores a hook that carries no effort", () => {
    // SubagentStart fires without effort — documented as absent for lifecycle hooks.
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    expect(source.observeHook(hook({ effort: undefined }))).toEqual([]);
  });

  it("survives a hook input of an unexpected shape", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(taskStarted());
    expect(source.observeHook({} as never)).toEqual([]);
    expect(source.observeHook({ agent_id: 42, effort: { level: 7 } } as never)).toEqual([]);
  });
});
