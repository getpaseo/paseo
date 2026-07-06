import { describe, expect, it } from "vitest";
import { ScheduleCreateRequestSchema } from "./rpc-schemas.js";

describe("schedule RPC schemas", () => {
  it("keeps new-agent workspace stamps out of create requests", () => {
    const parsed = ScheduleCreateRequestSchema.parse({
      type: "schedule/create",
      requestId: "request-1",
      prompt: "Run the task",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: "/tmp/project",
          workspaceId: "client-owned-workspace",
        },
      },
    });

    expect(parsed.target.type).toBe("new-agent");
    if (parsed.target.type === "new-agent") {
      expect(parsed.target.config).not.toHaveProperty("workspaceId");
    }
  });
});
