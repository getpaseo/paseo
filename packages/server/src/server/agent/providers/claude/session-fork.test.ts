import { describe, expect, test, vi } from "vitest";

import { forkClaudeSession, type ClaudeSessionForkSdk } from "./session-fork.js";

describe("forkClaudeSession", () => {
  test("copies the whole transcript rather than slicing it like rewind does", async () => {
    const forkSession = vi.fn().mockResolvedValue({ sessionId: "session-fork" });
    const sdk: ClaudeSessionForkSdk = { forkSession };

    const result = await forkClaudeSession({ sdk, sessionId: "session-source" });

    expect(result).toEqual({ sessionId: "session-fork" });
    expect(forkSession).toHaveBeenCalledTimes(1);
    // Rewind passes upToMessageId to branch mid-conversation. A tab fork must
    // not, or the new agent silently loses the tail of the transcript.
    expect(forkSession).toHaveBeenCalledWith("session-source");
  });

  test("throws instead of forking when the source session is not ready", async () => {
    const forkSession = vi.fn();
    const sdk: ClaudeSessionForkSdk = { forkSession };

    await expect(forkClaudeSession({ sdk, sessionId: null })).rejects.toThrow(
      "Claude session is not ready to fork",
    );
    expect(forkSession).not.toHaveBeenCalled();
  });
});
