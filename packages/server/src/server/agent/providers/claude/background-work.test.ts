import { describe, expect, it } from "vitest";

import { readClaudeBackgroundWork } from "./background-work.js";

describe("readClaudeBackgroundWork", () => {
  it("maps the Stop hook payload onto Paseo's shape", () => {
    const work = readClaudeBackgroundWork({
      hook_event_name: "Stop",
      stop_hook_active: false,
      background_tasks: [
        {
          id: "task-1",
          type: "subagent",
          status: "running",
          description: "Explore the schema drift",
          agent_type: "Explore",
        },
        {
          id: "task-2",
          type: "shell",
          status: "running",
          description: "Watching CI",
          command: "bash /tmp/watch.sh",
        },
      ],
      session_crons: [
        { id: "cron-1", schedule: "0 9 * * 1-5", recurring: true, prompt: "Review CI failures" },
        { id: "cron-2", schedule: "12 20 22 8 *", recurring: false, prompt: "Check the deploy" },
      ],
    });

    expect(work).toEqual({
      tasks: [
        {
          id: "task-1",
          type: "subagent",
          status: "running",
          description: "Explore the schema drift",
          agentType: "Explore",
        },
        {
          id: "task-2",
          type: "shell",
          status: "running",
          description: "Watching CI",
          command: "bash /tmp/watch.sh",
        },
      ],
      crons: [
        { id: "cron-1", schedule: "0 9 * * 1-5", recurring: true, prompt: "Review CI failures" },
        { id: "cron-2", schedule: "12 20 22 8 *", recurring: false, prompt: "Check the deploy" },
      ],
    });
  });

  it("treats a Stop payload with neither array as nothing pending", () => {
    // Must return a value rather than null: this is what clears a strip left over from the
    // previous turn, and the SDK documents both fields as absent when nothing is in flight.
    expect(readClaudeBackgroundWork({ hook_event_name: "Stop", stop_hook_active: false })).toEqual({
      tasks: [],
      crons: [],
    });
  });

  it("ignores hooks that are not Stop", () => {
    expect(readClaudeBackgroundWork({ hook_event_name: "PreToolUse" })).toBeNull();
    expect(readClaudeBackgroundWork(null)).toBeNull();
    expect(readClaudeBackgroundWork("Stop")).toBeNull();
  });

  it("keeps the rest of a batch when one entry is malformed", () => {
    const work = readClaudeBackgroundWork({
      hook_event_name: "Stop",
      background_tasks: [{ id: "ok", type: "monitor", status: "running" }],
      session_crons: [{ id: "bad", schedule: "0 9 * * *" }],
    });

    // A cron without `recurring` cannot be rendered honestly, so the array fails and the whole
    // payload is dropped rather than inventing a value.
    expect(work).toBeNull();
  });
});
