import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveExistingRunWorkspace,
  resolveRunCallerAgentId,
  runRunCommand,
  type AgentRunOptions,
} from "./run";

const createAgent = vi.fn();
const waitForFinish = vi.fn();
const close = vi.fn();

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    createAgent,
    waitForFinish,
    close,
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

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

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand("do something", { newWorkspace: "worktree", provider: undefined }, {} as never),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });
});

describe("--mcp-config", () => {
  const originalCallerAgentId = process.env.PASEO_AGENT_ID;

  function writeConfigFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "paseo-mcp-config-"));
    const path = join(dir, "mcp.json");
    writeFileSync(path, content, "utf8");
    return path;
  }

  beforeEach(() => {
    // Short-circuits workspace resolution so createAgent tests don't need to
    // stub out createWorkspace as well.
    process.env.PASEO_AGENT_ID = "parent-agent";
    createAgent.mockReset();
    waitForFinish.mockReset();
    close.mockReset();
  });

  afterEach(() => {
    if (originalCallerAgentId === undefined) {
      delete process.env.PASEO_AGENT_ID;
    } else {
      process.env.PASEO_AGENT_ID = originalCallerAgentId;
    }
  });

  it("omits mcpServers when --mcp-config is not provided", async () => {
    createAgent.mockResolvedValueOnce({
      id: "agent-1",
      status: "running",
      provider: "codex",
      cwd: "/tmp/project",
      title: null,
    });

    await runRunCommand("do something", { provider: "codex", background: true }, {} as never);

    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: undefined }));
  });

  it("parses a valid --mcp-config file and passes mcpServers to createAgent", async () => {
    const path = writeConfigFile(
      JSON.stringify({
        apify: { type: "stdio", command: "actors-mcp-server", args: [] },
      }),
    );
    createAgent.mockResolvedValueOnce({
      id: "agent-1",
      status: "running",
      provider: "codex",
      cwd: "/tmp/project",
      title: null,
    });

    await runRunCommand(
      "do something",
      { provider: "codex", background: true, mcpConfig: path },
      {} as never,
    );

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: {
          apify: { type: "stdio", command: "actors-mcp-server", args: [] },
        },
      }),
    );
  });

  it("rejects a nonexistent --mcp-config path before connecting to the daemon", async () => {
    await expect(
      runRunCommand("do something", { mcpConfig: "/no/such/mcp-config.json" }, {} as never),
    ).rejects.toMatchObject({ code: "INVALID_MCP_CONFIG" });
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON in --mcp-config", async () => {
    const path = writeConfigFile("{ not valid json");

    await expect(
      runRunCommand("do something", { mcpConfig: path }, {} as never),
    ).rejects.toMatchObject({ code: "INVALID_MCP_CONFIG" });
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("rejects a --mcp-config file that fails MCP server schema validation", async () => {
    const path = writeConfigFile(JSON.stringify({ apify: { type: "carrier-pigeon" } }));

    await expect(
      runRunCommand("do something", { mcpConfig: path }, {} as never),
    ).rejects.toMatchObject({ code: "INVALID_MCP_CONFIG" });
    expect(createAgent).not.toHaveBeenCalled();
  });
});
