import { describe, expect, it, vi } from "vitest";
import { forkClaudeSessionAtMessage } from "./native-fork.js";

describe("forkClaudeSessionAtMessage", () => {
  it("returns forked session id without requiring setSessionId on source", async () => {
    const sdk = {
      forkSession: vi.fn(async () => ({ sessionId: "forked-1" })),
    };
    const result = await forkClaudeSessionAtMessage({
      sdk,
      sessionId: "source-1",
      upToMessageId: "uuid-9",
      dir: "/tmp/project",
    });
    expect(result.forkedSessionId).toBe("forked-1");
    expect(sdk.forkSession).toHaveBeenCalledWith("source-1", {
      upToMessageId: "uuid-9",
      dir: "/tmp/project",
    });
  });

  it("rejects empty session id", async () => {
    await expect(
      forkClaudeSessionAtMessage({
        sdk: { forkSession: vi.fn() },
        sessionId: "  ",
        upToMessageId: "msg-9",
      }),
    ).rejects.toThrow(/not ready/i);
  });

  it("rejects empty boundary message id", async () => {
    await expect(
      forkClaudeSessionAtMessage({
        sdk: { forkSession: vi.fn() },
        sessionId: "source-1",
        upToMessageId: "",
      }),
    ).rejects.toThrow(/boundary message/i);
  });
});
