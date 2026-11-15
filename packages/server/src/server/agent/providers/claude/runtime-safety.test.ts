import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { ClaudeRuntimeSafety } from "./runtime-safety.js";

const message = (value: unknown) => value as SDKMessage;

test("enriches only live tasks with their correlated launch metadata", () => {
  const runtime = new ClaudeRuntimeSafety();
  runtime.observe(
    message({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Monitor",
            input: { description: "Watch build", command: "tail -f build.log" },
          },
          { type: "tool_use", id: "old", name: "Bash", input: { command: "old command" } },
        ],
      },
    }),
  );
  runtime.observe(
    message({ type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "tool-1" }),
  );
  expect(
    runtime.observe(
      message({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "task-1", task_type: "local_bash", description: "Watch build" }],
      }),
    ),
  ).toEqual([
    {
      id: "task-1",
      kind: "monitor",
      description: "Watch build",
      command: "tail -f build.log",
      canStop: true,
    },
  ]);
  expect(
    runtime.observe(message({ type: "system", subtype: "background_tasks_changed", tasks: [] })),
  ).toEqual([]);
});

test("keeps the runtime while Claude's last Stop hook lists session crons", () => {
  const runtime = new ClaudeRuntimeSafety();
  runtime.observe(message({ type: "system", subtype: "init", claude_code_version: "2.1.321" }));
  const cron = { id: "99eb0b69", schedule: "0 */6 * * *", recurring: true, prompt: "say hi" };

  runtime.observeStop({ session_crons: [cron] });
  expect(runtime.canStopRuntime()).toBe(false);

  runtime.observeStop({});
  expect(runtime.canStopRuntime()).toBe(false);

  runtime.observeStop({ session_crons: [] });
  expect(runtime.canStopRuntime()).toBe(true);

  runtime.observeStop({ session_crons: [cron] });
  runtime.reset();
  runtime.observe(message({ type: "system", subtype: "init", claude_code_version: "2.1.321" }));
  expect(runtime.canStopRuntime()).toBe(true);
});
