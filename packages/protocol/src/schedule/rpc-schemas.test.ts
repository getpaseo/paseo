import { describe, expect, it } from "vitest";
import {
  ScheduleCreateRequestSchema,
  ScheduleStateRestoreRequestSchema,
  ScheduleStateTransitionRequestSchema,
  ScheduleUpdateRequestSchema,
} from "./rpc-schemas.js";

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

  it("keeps exact state operation ownership fields on the wire", () => {
    expect(
      ScheduleStateTransitionRequestSchema.parse({
        type: "schedule.state.transition.request",
        requestId: "request-1",
        operationId: "operation-1",
        scheduleId: "schedule-1",
        targetStatus: "paused",
      }),
    ).toEqual({
      type: "schedule.state.transition.request",
      requestId: "request-1",
      operationId: "operation-1",
      scheduleId: "schedule-1",
      targetStatus: "paused",
    });
    expect(
      ScheduleStateRestoreRequestSchema.parse({
        type: "schedule.state.restore.request",
        requestId: "request-2",
        operationId: "operation-1",
        scheduleId: "schedule-1",
      }),
    ).toEqual({
      type: "schedule.state.restore.request",
      requestId: "request-2",
      operationId: "operation-1",
      scheduleId: "schedule-1",
    });
  });
});
