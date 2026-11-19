import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import { resolveCallerAgentId as resolveRunCallerAgentId } from "../../utils/caller-agent.js";
import { connectToDaemon } from "../../utils/client.js";
import {
  addRunOptions,
  resolveExistingRunWorkspace,
  runRunCommand,
  waitsForFinish,
  type AgentRunOptions,
} from "./run";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

// Answers fetchAgent the way a daemon does: an unknown id is an error.
function daemonWithAgents(...agentIds: string[]) {
  return {
    async fetchAgent({ agentId }: { agentId: string }) {
      if (!agentIds.includes(agentId)) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      return { agent: { id: agentId } };
    },
  };
}

describe("run wait policy", () => {
  it.each([
    { flags: [], background: undefined, waits: true },
    { flags: ["--background"], background: true, waits: true },
    { flags: ["--no-background"], background: false, waits: true },
    { flags: ["--background", "--no-wait"], background: true, waits: false },
    { flags: ["-d"], background: undefined, waits: false },
    { flags: ["--detach"], background: undefined, waits: false },
  ])("keeps visibility and waiting independent for $flags", ({ flags, background, waits }) => {
    const command = addRunOptions(new Command());
    command.parse([...flags, "do something"], { from: "user" });
    const options = command.opts<AgentRunOptions>();
    expect(options.background).toBe(background);
    expect(waitsForFinish(options)).toBe(waits);
  });
});

describe("managed agent caller context", () => {
  it("uses a trimmed PASEO_AGENT_ID when the target daemon runs that agent", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("parent-agent"), {
        PASEO_AGENT_ID: "  parent-agent  ",
      }),
    ).resolves.toBe("parent-agent");
  });

  it("runs without a caller when PASEO_AGENT_ID belongs to another daemon", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("other-agent"), {
        PASEO_AGENT_ID: "parent-agent",
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["DAEMON_CONNECTION_LOST", "DAEMON_REQUEST_TIMEOUT"] as const)(
    "preserves %s instead of dropping the caller",
    async (code) => {
      const disconnectedDaemon = {
        async fetchAgent(): Promise<never> {
          throw new DaemonConnectionError("Caller lookup transport failed", code);
        },
      };

      await expect(
        resolveRunCallerAgentId(disconnectedDaemon, { PASEO_AGENT_ID: "parent-agent" }),
      ).rejects.toBeInstanceOf(DaemonConnectionError);
    },
  );

  it("omits blank caller ids", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents(), { PASEO_AGENT_ID: "   " }),
    ).resolves.toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("uses the directory of the workspace found by id", async () => {
    const findWorkspace = vi
      .fn()
      .mockResolvedValue({ id: "workspace-2", workspaceDirectory: "/workspace/two" });

    await expect(resolveExistingRunWorkspace({ findWorkspace }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(findWorkspace).toHaveBeenCalledWith("workspace-2");
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const findWorkspace = vi.fn().mockResolvedValue(null);

    await expect(resolveExistingRunWorkspace({ findWorkspace }, "missing")).rejects.toMatchObject({
      code: "WORKSPACE_NOT_FOUND",
      message: "Workspace not found: missing",
    });
  });
});

describe("run background host compatibility", () => {
  it.each([true, false])(
    "rejects background=%s before creating anything on an older host",
    async (background) => {
      const client = {
        getLastServerInfoMessage: () => ({ features: { backgroundWorkspaces: true } }),
        fetchAgent: vi.fn().mockRejectedValue(new Error("Agent not found")),
        createWorkspace: vi.fn(),
        createAgent: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(connectToDaemon).mockResolvedValueOnce(
        client as unknown as Awaited<ReturnType<typeof connectToDaemon>>,
      );

      await expect(
        runRunCommand(
          "do something",
          { provider: "claude", background, daemonTarget },
          new Command(),
        ),
      ).rejects.toMatchObject({ code: "DAEMON_UPDATE_REQUIRED" });
      expect(client.createWorkspace).not.toHaveBeenCalled();
      expect(client.createAgent).not.toHaveBeenCalled();
    },
  );
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

  async function expectInvalidOptions(
    options: Omit<AgentRunOptions, "daemonTarget">,
    messageMatch: RegExp,
  ) {
    await expect(
      runRunCommand("do something", { ...options, daemonTarget }, {} as never),
    ).rejects.toMatchObject({
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
      runRunCommand(
        "do something",
        { newWorkspace: "worktree", provider: undefined, daemonTarget },
        {} as never,
      ),
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
