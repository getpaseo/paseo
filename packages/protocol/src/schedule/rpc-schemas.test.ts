import { describe, expect, it } from "vitest";
import { ScheduleCreateRequestSchema, ScheduleUpdateRequestSchema } from "./rpc-schemas.js";

describe("schedule RPC schemas", () => {
  it("round-trips new-agent run options on create requests", () => {
    expect(
      ScheduleCreateRequestSchema.parse({
        type: "schedule/create",
        requestId: "request-1",
        prompt: "Run the task",
        cadence: { type: "every", everyMs: 60_000 },
        target: {
          type: "new-agent",
          config: {
            provider: "claude",
            cwd: "/tmp/project",
            thinkingOptionId: "think-hard",
            archiveOnFinish: false,
            isolation: "worktree",
          },
        },
      }),
    ).toEqual({
      type: "schedule/create",
      requestId: "request-1",
      prompt: "Run the task",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: "/tmp/project",
          thinkingOptionId: "think-hard",
          archiveOnFinish: false,
          isolation: "worktree",
        },
      },
    });
  });

  it("accepts a workspace in place of cwd on create requests", () => {
    const request = {
      type: "schedule/create",
      requestId: "request-1",
      prompt: "Run the task",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", workspaceId: "wks_weekly", archiveOnFinish: false },
      },
    };

    expect(ScheduleCreateRequestSchema.parse(request)).toEqual(request);
  });

  it("still parses create requests that name a cwd and no workspace", () => {
    const parsed = ScheduleCreateRequestSchema.parse({
      type: "schedule/create",
      requestId: "request-1",
      prompt: "Run the task",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: "/tmp/project" } },
    });

    expect(parsed.target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/tmp/project" },
    });
  });

  it("binds and clears the workspace on update requests", () => {
    const update = (workspaceId: string | null) =>
      ScheduleUpdateRequestSchema.parse({
        type: "schedule/update",
        requestId: "request-1",
        scheduleId: "schedule-1",
        newAgentConfig: { workspaceId },
      });

    expect(update("wks_weekly").newAgentConfig).toEqual({ workspaceId: "wks_weekly" });
    expect(update(null).newAgentConfig).toEqual({ workspaceId: null });
  });

  it("rejects an empty workspace on create and update requests", () => {
    expect(() =>
      ScheduleCreateRequestSchema.parse({
        type: "schedule/create",
        requestId: "request-1",
        prompt: "Run the task",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "new-agent", config: { provider: "claude", workspaceId: "  " } },
      }),
    ).toThrow();
    expect(() =>
      ScheduleUpdateRequestSchema.parse({
        type: "schedule/update",
        requestId: "request-1",
        scheduleId: "schedule-1",
        newAgentConfig: { workspaceId: "" },
      }),
    ).toThrow();
  });

  it("round-trips new-agent run options on update requests", () => {
    expect(
      ScheduleUpdateRequestSchema.parse({
        type: "schedule/update",
        requestId: "request-1",
        scheduleId: "schedule-1",
        newAgentConfig: {
          thinkingOptionId: "think-hard",
          archiveOnFinish: false,
          isolation: "worktree",
        },
      }),
    ).toEqual({
      type: "schedule/update",
      requestId: "request-1",
      scheduleId: "schedule-1",
      newAgentConfig: {
        thinkingOptionId: "think-hard",
        archiveOnFinish: false,
        isolation: "worktree",
      },
    });
  });
});
