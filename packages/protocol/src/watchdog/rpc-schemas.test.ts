import { describe, expect, test } from "vitest";

import {
  WatchdogCancelRequestSchema,
  WatchdogInspectResponseSchema,
  WatchdogStartRequestSchema,
} from "./rpc-schemas.js";

describe("watchdog RPC schemas", () => {
  test("accepts a durable command request with timeout", () => {
    expect(
      WatchdogStartRequestSchema.parse({
        type: "watchdog.start.request",
        requestId: "request-1",
        name: "vision tests",
        agentId: "agent-1",
        workspaceId: "workspace-1",
        cwd: "/workspace",
        command: "npm",
        args: ["test"],
        timeoutMs: 60_000,
      }),
    ).toMatchObject({ command: "npm", timeoutMs: 60_000 });
  });

  test("leaves omitted args undefined for post-validation normalization", () => {
    expect(
      WatchdogStartRequestSchema.parse({
        type: "watchdog.start.request",
        requestId: "request-1",
        name: "vision tests",
        agentId: "agent-1",
        workspaceId: "workspace-1",
        cwd: "/workspace",
        command: "npm",
      }).args,
    ).toBeUndefined();
  });

  test("rejects invalid cancellation ids", () => {
    expect(() =>
      WatchdogCancelRequestSchema.parse({
        type: "watchdog.cancel.request",
        requestId: "request-1",
        jobId: "../outside",
      }),
    ).toThrow();
  });

  test("represents delivery separately from command status", () => {
    expect(
      WatchdogInspectResponseSchema.parse({
        type: "watchdog.inspect.response",
        payload: {
          requestId: "request-1",
          error: null,
          job: {
            id: "watchdog-1",
            name: "vision tests",
            agentId: "agent-1",
            workspaceId: "workspace-1",
            cwd: "/workspace",
            command: "npm",
            args: ["test"],
            status: "completed",
            deliveryStatus: "delivered",
            workerPid: 4101,
            result: {
              exitCode: 0,
              signal: null,
              error: null,
              finishedAt: "2026-08-19T00:05:00.000Z",
              stdout: { bytes: 12, truncated: false },
              stderr: { bytes: 0, truncated: false },
            },
            timeoutMs: null,
            cancelRequestedAt: null,
            createdAt: "2026-08-19T00:00:00.000Z",
            updatedAt: "2026-08-19T00:05:00.000Z",
            deliveredAt: "2026-08-19T00:05:00.000Z",
          },
        },
      }).payload.job,
    ).toMatchObject({ status: "completed", deliveryStatus: "delivered" });
  });
});
