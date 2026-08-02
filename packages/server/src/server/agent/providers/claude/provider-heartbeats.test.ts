import { describe, expect, it } from "vitest";
import { ProviderHeartbeatStore } from "../../provider-heartbeats/store.js";
import {
  applyClaudeProviderHeartbeatToolEvent,
  mapClaudeProviderHeartbeatToolEvent,
} from "./provider-heartbeats.js";

const PARENT = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-08-02T12:00:00.000Z";

describe("mapClaudeProviderHeartbeatToolEvent", () => {
  it("maps CronCreate result to upsert", () => {
    const event = mapClaudeProviderHeartbeatToolEvent(
      {
        toolName: "CronCreate",
        toolInput: {
          cron: "*/5 * * * *",
          prompt: "check CI",
          recurring: true,
        },
        toolOutput: { id: "job-1" },
      },
      NOW,
    );
    expect(event).toEqual({
      kind: "upsert",
      task: {
        taskId: "job-1",
        parentAgentId: "",
        provider: "claude",
        prompt: "check CI",
        mode: "recurring",
        scheduleLabel: "*/5 * * * *",
        nextHint: null,
        updatedAt: NOW,
      },
    });
  });

  it("maps cron_create with nested JSON output", () => {
    const event = mapClaudeProviderHeartbeatToolEvent(
      {
        toolName: "cron_create",
        toolInput: {
          cron: "0 9 * * 1-5",
          prompt: "standup",
          recurring: false,
        },
        toolOutput: { output: JSON.stringify({ id: "job-2", jobId: "ignored" }) },
      },
      NOW,
    );
    expect(event?.kind).toBe("upsert");
    if (event?.kind !== "upsert") return;
    expect(event.task.taskId).toBe("job-2");
    expect(event.task.mode).toBe("one_shot");
    expect(event.task.scheduleLabel).toBe("0 9 * * 1-5");
  });

  it("maps CronDelete to remove by id", () => {
    const event = mapClaudeProviderHeartbeatToolEvent(
      {
        toolName: "CronDelete",
        toolInput: { id: "job-1" },
        toolOutput: { ok: true },
      },
      NOW,
    );
    expect(event).toEqual({ kind: "remove", taskId: "job-1" });
  });

  it("maps CronList array to replaceLiveSet", () => {
    const event = mapClaudeProviderHeartbeatToolEvent(
      {
        toolName: "CronList",
        toolInput: {},
        toolOutput: [
          {
            id: "a",
            cron: "0 * * * *",
            prompt: "hourly",
            recurring: true,
          },
          {
            id: "b",
            cron: "30 14 * * *",
            prompt: "once",
            recurring: false,
          },
        ],
      },
      NOW,
    );
    expect(event?.kind).toBe("replace");
    if (event?.kind !== "replace") return;
    expect(event.tasks.map((t) => t.taskId)).toEqual(["a", "b"]);
    expect(event.tasks[0]?.mode).toBe("recurring");
    expect(event.tasks[1]?.mode).toBe("one_shot");
  });

  it("maps ScheduleWakeup delay to dynamic upsert", () => {
    const event = mapClaudeProviderHeartbeatToolEvent(
      {
        toolName: "ScheduleWakeup",
        toolInput: {
          delaySeconds: 270,
          reason: "watching CI",
          prompt: "re-check CI",
        },
        toolOutput: null,
      },
      NOW,
    );
    expect(event?.kind).toBe("upsert");
    if (event?.kind !== "upsert") return;
    expect(event.task.mode).toBe("dynamic");
    expect(event.task.scheduleLabel).toBe("self-paced");
    expect(event.task.taskId).toBe("dynamic");
    expect(event.task.nextHint).toContain("270");
    expect(event.task.nextHint).toContain("watching CI");
    expect(event.task.prompt).toBe("re-check CI");
  });

  it("maps ScheduleWakeup stop to remove dynamic", () => {
    const event = mapClaudeProviderHeartbeatToolEvent(
      {
        toolName: "ScheduleWakeup",
        toolInput: { stop: true },
        toolOutput: {},
      },
      NOW,
    );
    expect(event).toEqual({ kind: "remove", taskId: "dynamic" });
  });

  it("ignores unrelated tools", () => {
    expect(
      mapClaudeProviderHeartbeatToolEvent(
        {
          toolName: "Bash",
          toolInput: { command: "ls" },
          toolOutput: { stdout: "ok" },
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("returns null for failed schedule tools", () => {
    expect(
      mapClaudeProviderHeartbeatToolEvent(
        {
          toolName: "CronDelete",
          toolInput: { id: "job-1" },
          toolOutput: { error: "failed" },
          isError: true,
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      mapClaudeProviderHeartbeatToolEvent(
        {
          toolName: "CronCreate",
          toolInput: { cron: "* * * * *", prompt: "x", recurring: true },
          toolOutput: { id: "job-1" },
          isError: true,
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      mapClaudeProviderHeartbeatToolEvent(
        {
          toolName: "CronList",
          toolInput: {},
          toolOutput: [],
          isError: true,
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      mapClaudeProviderHeartbeatToolEvent(
        {
          toolName: "ScheduleWakeup",
          toolInput: { stop: true },
          toolOutput: null,
          isError: true,
        },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("applyClaudeProviderHeartbeatToolEvent", () => {
  it("applies CronCreate and CronDelete against the store", () => {
    const store = new ProviderHeartbeatStore();
    const created = applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "CronCreate",
        toolInput: { cron: "*/5 * * * *", prompt: "check CI", recurring: true },
        toolOutput: { id: "job-1" },
      },
      NOW,
    );
    expect(created.changed).toBe(true);
    expect(created.heartbeats.map((h) => h.taskId)).toEqual(["job-1"]);
    expect(created.heartbeats[0]?.parentAgentId).toBe(PARENT);

    const deleted = applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "cron_delete",
        toolInput: { id: "job-1" },
        toolOutput: {},
      },
      NOW,
    );
    expect(deleted.changed).toBe(true);
    expect(deleted.heartbeats).toEqual([]);
  });

  it("replaces live set from CronList", () => {
    const store = new ProviderHeartbeatStore();
    store.upsert(PARENT, {
      taskId: "old",
      parentAgentId: PARENT,
      provider: "claude",
      prompt: "gone",
      mode: "recurring",
      scheduleLabel: "0 0 * * *",
      nextHint: null,
      updatedAt: NOW,
    });
    const result = applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "CronList",
        toolInput: {},
        toolOutput: {
          output: JSON.stringify([
            { id: "new-1", cron: "0 * * * *", prompt: "hourly", recurring: true },
          ]),
        },
      },
      NOW,
    );
    expect(result.changed).toBe(true);
    expect(result.heartbeats.map((h) => h.taskId)).toEqual(["new-1"]);
  });

  it("updates and clears dynamic ScheduleWakeup", () => {
    const store = new ProviderHeartbeatStore();
    const scheduled = applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "ScheduleWakeup",
        toolInput: { delaySeconds: 60, reason: "idle", prompt: "loop" },
        toolOutput: null,
      },
      NOW,
    );
    expect(scheduled.heartbeats).toHaveLength(1);
    expect(scheduled.heartbeats[0]?.taskId).toBe("dynamic");

    const stopped = applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "ScheduleWakeup",
        toolInput: { stop: true },
        toolOutput: null,
      },
      NOW,
    );
    expect(stopped.changed).toBe(true);
    expect(stopped.heartbeats).toEqual([]);
  });

  it("clear deletes parent membership", () => {
    const store = new ProviderHeartbeatStore();
    applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "CronCreate",
        toolInput: { cron: "* * * * *", prompt: "x", recurring: true },
        toolOutput: { id: "j1" },
      },
      NOW,
    );
    const cleared = applyClaudeProviderHeartbeatToolEvent(store, PARENT, { kind: "clear" }, NOW);
    expect(cleared.changed).toBe(true);
    expect(cleared.heartbeats).toEqual([]);
  });

  it("preserves dynamic ScheduleWakeup when CronList replaces cron membership", () => {
    const store = new ProviderHeartbeatStore();
    applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "ScheduleWakeup",
        toolInput: { delaySeconds: 120, reason: "watching CI", prompt: "loop" },
        toolOutput: null,
      },
      NOW,
    );
    applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "CronCreate",
        toolInput: { cron: "0 * * * *", prompt: "hourly", recurring: true },
        toolOutput: { id: "cron-old" },
      },
      NOW,
    );

    const result = applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "CronList",
        toolInput: {},
        toolOutput: [{ id: "cron-new", cron: "*/5 * * * *", prompt: "check CI", recurring: true }],
      },
      NOW,
    );

    expect(result.heartbeats.map((h) => h.taskId).sort()).toEqual(["cron-new", "dynamic"]);
    expect(result.heartbeats.find((h) => h.taskId === "dynamic")?.mode).toBe("dynamic");
    expect(result.heartbeats.find((h) => h.taskId === "cron-old")).toBeUndefined();
  });

  it("keeps dynamic rows when CronList is empty", () => {
    const store = new ProviderHeartbeatStore();
    applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "ScheduleWakeup",
        toolInput: { delaySeconds: 60, prompt: "loop" },
        toolOutput: null,
      },
      NOW,
    );
    applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "CronCreate",
        toolInput: { cron: "0 * * * *", prompt: "hourly", recurring: true },
        toolOutput: { id: "cron-1" },
      },
      NOW,
    );

    const result = applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "CronList",
        toolInput: {},
        toolOutput: [],
      },
      NOW,
    );

    expect(result.heartbeats).toHaveLength(1);
    expect(result.heartbeats[0]?.taskId).toBe("dynamic");
    expect(result.heartbeats[0]?.mode).toBe("dynamic");
  });

  it("does not remove on failed CronDelete", () => {
    const store = new ProviderHeartbeatStore();
    applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "CronCreate",
        toolInput: { cron: "*/5 * * * *", prompt: "check CI", recurring: true },
        toolOutput: { id: "job-1" },
      },
      NOW,
    );

    const failed = applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "CronDelete",
        toolInput: { id: "job-1" },
        toolOutput: { error: "not found" },
        isError: true,
      },
      NOW,
    );

    expect(failed.changed).toBe(false);
    expect(failed.heartbeats.map((h) => h.taskId)).toEqual(["job-1"]);
  });

  it("does not upsert on failed CronCreate", () => {
    const store = new ProviderHeartbeatStore();
    const failed = applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "CronCreate",
        toolInput: { cron: "*/5 * * * *", prompt: "check CI", recurring: true },
        toolOutput: { id: "job-err" },
        isError: true,
      },
      NOW,
    );

    expect(failed.changed).toBe(false);
    expect(failed.heartbeats).toEqual([]);
  });

  it("does not replace on failed CronList", () => {
    const store = new ProviderHeartbeatStore();
    applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "CronCreate",
        toolInput: { cron: "0 * * * *", prompt: "hourly", recurring: true },
        toolOutput: { id: "job-1" },
      },
      NOW,
    );

    const failed = applyClaudeProviderHeartbeatToolEvent(
      store,
      PARENT,
      {
        toolName: "CronList",
        toolInput: {},
        toolOutput: [],
        isError: true,
      },
      NOW,
    );

    expect(failed.changed).toBe(false);
    expect(failed.heartbeats.map((h) => h.taskId)).toEqual(["job-1"]);
  });
});
