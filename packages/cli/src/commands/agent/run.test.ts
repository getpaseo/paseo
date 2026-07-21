import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveExistingRunWorkspace,
  resolveRunCallerAgentId,
  runRunCommand,
  type AgentRunOptions,
} from "./run";

describe("managed agent caller context", () => {
  it("propagates a trimmed PASEO_AGENT_ID", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "  parent-agent  " })).toBe("parent-agent");
  });

  it("omits blank caller ids", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "   " })).toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

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

  it("rejects --isolation combined with --workspace", async () => {
    await expectInvalidOptions(
      { isolation: "worktree", workspace: "ws-1" },
      /--isolation and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree isolation through validation", async () => {
    // Explicit isolation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand("do something", { isolation: "worktree", provider: undefined }, {} as never),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown workspace isolation", async () => {
    await expectInvalidOptions({ isolation: "container" }, /Unsupported workspace isolation/);
  });
});
