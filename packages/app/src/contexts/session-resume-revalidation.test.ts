import { describe, expect, it } from "vitest";
import {
  revalidateSessionAfterResume,
  SESSION_STALE_AFTER_MS,
} from "./session-resume-revalidation";

describe("session resume revalidation", () => {
  it("refreshes both directories and timeline history after a stale resume", async () => {
    const calls: string[] = [];

    const revalidated = await revalidateSessionAfterResume({
      awayMs: SESSION_STALE_AFTER_MS,
      serverId: "server",
      bumpHistorySyncGeneration: (serverId) => calls.push(`history:${serverId}`),
      refreshAgentDirectory: async () => calls.push("agents"),
      hydrateWorkspaces: async () => {
        calls.push("workspaces");
      },
    });

    expect(revalidated).toBe(true);
    expect(calls).toEqual(["history:server", "agents", "workspaces"]);
  });

  it("does nothing after a brief background interval", async () => {
    const calls: string[] = [];

    const revalidated = await revalidateSessionAfterResume({
      awayMs: SESSION_STALE_AFTER_MS - 1,
      serverId: "server",
      bumpHistorySyncGeneration: () => calls.push("history"),
      refreshAgentDirectory: async () => calls.push("agents"),
      hydrateWorkspaces: async () => {
        calls.push("workspaces");
      },
    });

    expect(revalidated).toBe(false);
    expect(calls).toEqual([]);
  });
});
