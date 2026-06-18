import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRunCommand, type AgentRunOptions } from "./run";

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  async function expectInvalidOptions(options: AgentRunOptions, messageMatch: RegExp) {
    await expect(runRunCommand("do something", options, {} as never)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --worktree combined with --workspace", async () => {
    await expectInvalidOptions(
      { worktree: "feat", workspace: "ws-1" },
      /--worktree and --workspace cannot be combined/,
    );
  });

  it("rejects --worktree combined with an ambient PASEO_WORKSPACE_ID", async () => {
    process.env.PASEO_WORKSPACE_ID = "ws-ambient";
    await expectInvalidOptions(
      { worktree: "feat" },
      /--worktree cannot be combined with an ambient PASEO_WORKSPACE_ID/,
    );
  });

  it("allows a bare --worktree through validation when no workspace is selected", async () => {
    // A bare --worktree with no --workspace and no ambient PASEO_WORKSPACE_ID
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand("do something", { worktree: "feat", provider: undefined }, {} as never),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });
});
