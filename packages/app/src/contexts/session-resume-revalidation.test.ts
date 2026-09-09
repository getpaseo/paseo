import { describe, expect, it } from "vitest";
import {
  revalidateSessionAfterResume,
  SESSION_STALE_AFTER_MS,
} from "./session-resume-revalidation";

describe("session resume revalidation", () => {
  it("refreshes demanded timeline history without manufacturing directory demand", async () => {
    const calls: string[] = [];

    const revalidated = await revalidateSessionAfterResume({
      awayMs: SESSION_STALE_AFTER_MS,
      serverId: "server",
      bumpHistorySyncGeneration: (serverId) => calls.push(`history:${serverId}`),
    });

    expect(revalidated).toBe(true);
    expect(calls).toEqual(["history:server"]);
  });

  it("does nothing after a brief background interval", async () => {
    const calls: string[] = [];

    const revalidated = await revalidateSessionAfterResume({
      awayMs: SESSION_STALE_AFTER_MS - 1,
      serverId: "server",
      bumpHistorySyncGeneration: () => calls.push("history"),
    });

    expect(revalidated).toBe(false);
    expect(calls).toEqual([]);
  });
});
