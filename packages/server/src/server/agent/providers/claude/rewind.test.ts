import { describe, expect, test, vi } from "vitest";
import { revertClaudeFiles } from "./rewind.js";

describe("Claude file rewind", () => {
  test("rewinds tracked files to the selected user message", async () => {
    const rewindFiles = vi.fn().mockResolvedValue({ canRewind: true });
    await revertClaudeFiles({ query: { rewindFiles }, messageId: "user-message" });
    expect(rewindFiles).toHaveBeenCalledWith("user-message", { dryRun: false });
  });

  test("reports the provider error when the files could not be rewound", async () => {
    const rewindFiles = vi
      .fn()
      .mockResolvedValue({ canRewind: false, error: "Checkpoint unavailable" });
    await expect(
      revertClaudeFiles({ query: { rewindFiles }, messageId: "user-message" }),
    ).rejects.toThrow("Checkpoint unavailable");
  });
});
