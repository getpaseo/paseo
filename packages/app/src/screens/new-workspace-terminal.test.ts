import { describe, expect, it, vi } from "vitest";
import { runCreateTerminalWorkspace } from "./new-workspace-terminal";

function createRecordingNavigate() {
  const recorded: Array<{ serverId: string; workspaceId: string; target: unknown }> = [];
  return {
    recorded,
    navigate: (serverId: string, workspaceId: string, target: unknown) => {
      recorded.push({ serverId, workspaceId, target });
    },
  };
}

describe("runCreateTerminalWorkspace", () => {
  it("creates the workspace without a chat agent, substitutes the prompt into the profile, and navigates to the terminal tab", async () => {
    const workspace = { id: "workspace-123", workspaceDirectory: "/repo/workspace-123" };
    const ensureWorkspace = vi.fn().mockResolvedValue(workspace);
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-1" });
    const sendTerminalInput = vi.fn();
    const { navigate, recorded } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "fix the bug",
      profile: { command: "claude", args: ["{{{prompt}}}"] },
      profileName: "Claude Code",
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    // Seeds the generated title and branch name without creating a chat agent.
    expect(ensureWorkspace).toHaveBeenCalledWith({
      cwd: "/repo",
      prompt: "fix the bug",
      attachments: [],
      withInitialAgent: false,
    });
    expect(createTerminal).toHaveBeenCalledWith({
      workspaceDirectory: "/repo/workspace-123",
      workspaceId: "workspace-123",
      name: "Claude Code",
      command: "claude",
      args: ["fix the bug"],
    });
    expect(recorded).toEqual([
      {
        serverId: "server-abc",
        workspaceId: "workspace-123",
        target: { kind: "terminal", terminalId: "term-1" },
      },
    ]);
  });

  it("drops a sentinel-only arg when the prompt is empty, so a bare command still launches", async () => {
    const workspace = { id: "ws-1", workspaceDirectory: "/repo/ws-1" };
    const ensureWorkspace = vi.fn().mockResolvedValue(workspace);
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-2" });
    const sendTerminalInput = vi.fn();
    const { navigate } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "",
      profile: { command: "claude", args: ["{{{prompt}}}"] },
      profileName: "Claude Code",
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    expect(createTerminal).toHaveBeenCalledWith({
      workspaceDirectory: "/repo/ws-1",
      workspaceId: "ws-1",
      name: "Claude Code",
      command: "claude",
      args: [],
    });
  });

  it("does not type into the terminal when a profile took the prompt as argv", async () => {
    const ensureWorkspace = vi
      .fn()
      .mockResolvedValue({ id: "ws-9", workspaceDirectory: "/repo/ws-9" });
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-9" });
    const sendTerminalInput = vi.fn();
    const { navigate } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "fix the bug",
      profile: { command: "claude", args: ["{{{prompt}}}"] },
      profileName: "Claude Code",
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    expect(sendTerminalInput).not.toHaveBeenCalled();
  });

  it("seeds workspace naming from a blank terminal's command too", async () => {
    const ensureWorkspace = vi
      .fn()
      .mockResolvedValue({ id: "ws-7", workspaceDirectory: "/repo/ws-7" });
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-7" });
    const sendTerminalInput = vi.fn();
    const { navigate } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "npm run dev",
      profile: null,
      profileName: undefined,
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    expect(ensureWorkspace).toHaveBeenCalledWith({
      cwd: "/repo",
      prompt: "npm run dev",
      attachments: [],
      withInitialAgent: false,
    });
  });

  it("types the command into the shell, with a carriage return, for a blank terminal", async () => {
    const ensureWorkspace = vi
      .fn()
      .mockResolvedValue({ id: "ws-5", workspaceDirectory: "/repo/ws-5" });
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-5" });
    const sendTerminalInput = vi.fn();
    const { navigate } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "  npm run dev  ",
      profile: null,
      profileName: undefined,
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    // The shell parses it, so it is typed rather than turned into argv.
    expect(createTerminal).toHaveBeenCalledWith({
      workspaceDirectory: "/repo/ws-5",
      workspaceId: "ws-5",
      name: undefined,
    });
    expect(sendTerminalInput).toHaveBeenCalledWith("term-5", "npm run dev\r");
  });

  it("launches a blank terminal without typing anything when no command was entered", async () => {
    const ensureWorkspace = vi
      .fn()
      .mockResolvedValue({ id: "ws-6", workspaceDirectory: "/repo/ws-6" });
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-6" });
    const sendTerminalInput = vi.fn();
    const { navigate } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "   ",
      profile: null,
      profileName: undefined,
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    expect(sendTerminalInput).not.toHaveBeenCalled();
  });

  it("launches the default shell with no command/args and no name when profile is null", async () => {
    const workspace = { id: "ws-1", workspaceDirectory: "/repo/ws-1" };
    const ensureWorkspace = vi.fn().mockResolvedValue(workspace);
    const createTerminal = vi.fn().mockResolvedValue({ terminalId: "term-3" });
    const sendTerminalInput = vi.fn();
    const { navigate } = createRecordingNavigate();

    await runCreateTerminalWorkspace({
      cwd: "/repo",
      prompt: "ls -la",
      profile: null,
      profileName: undefined,
      ensureWorkspace,
      createTerminal,
      sendTerminalInput,
      serverId: "server-abc",
      navigate,
    });

    expect(createTerminal).toHaveBeenCalledWith({
      workspaceDirectory: "/repo/ws-1",
      workspaceId: "ws-1",
      name: undefined,
    });
  });
});
