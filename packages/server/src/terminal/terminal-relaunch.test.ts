import { describe, expect, it } from "vitest";
import type { PersistedTerminal } from "./persisted-terminal-store.js";
import { planTerminalRelaunch } from "./terminal-relaunch.js";

function record(overrides: Partial<PersistedTerminal> = {}): PersistedTerminal {
  return {
    id: "term-1",
    workspaceId: "ws-1",
    cwd: "/repo",
    name: "Terminal 1",
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("planTerminalRelaunch", () => {
  it("relaunches a plain shell when nothing else is known", () => {
    expect(planTerminalRelaunch(record())).toEqual({ kind: "command" });
  });

  it("restores a Claude prompt terminal without a session as a plain shell", () => {
    expect(planTerminalRelaunch(record({ command: "claude", args: ["fix the build"] }))).toEqual({
      kind: "command",
    });
  });

  it("never replays an OpenCode prompt terminal", () => {
    expect(
      planTerminalRelaunch(record({ command: "opencode", args: ["--prompt=fix the build"] })),
    ).toEqual({ kind: "command" });
  });

  it("never replays an arbitrary command", () => {
    expect(
      planTerminalRelaunch(
        record({
          command: "npm",
          args: ["run", "deploy"],
          agentSession: { provider: "claude", sessionId: "abc-123" },
        }),
      ),
    ).toEqual({ kind: "command" });
  });

  it("resumes Claude with the original flags and without the original prompt", () => {
    const plan = planTerminalRelaunch(
      record({
        command: "/usr/local/bin/claude",
        args: ["--model", "opus", "--dangerously-skip-permissions", "fix the build"],
        agentSession: { provider: "claude", sessionId: "6f1c2a52-1d0e-4c3b-9d5e-0f7a8b9c0d1e" },
      }),
    );

    expect(plan).toEqual({
      kind: "command",
      command: "/usr/local/bin/claude",
      args: [
        "--model",
        "opus",
        "--dangerously-skip-permissions",
        "--resume",
        "6f1c2a52-1d0e-4c3b-9d5e-0f7a8b9c0d1e",
      ],
    });
  });

  it("keeps known boolean flags and drops the prompt after them", () => {
    const plan = planTerminalRelaunch(
      record({
        command: "claude",
        args: ["--strict-mcp-config", "fix the build", "--chrome"],
        agentSession: { provider: "claude", sessionId: "s-1" },
      }),
    );

    expect(plan).toEqual({
      kind: "command",
      command: "claude",
      args: ["--strict-mcp-config", "--chrome", "--resume", "s-1"],
    });
  });

  it("keeps the values of Claude value flags such as --name and --tools", () => {
    const plan = planTerminalRelaunch(
      record({
        command: "claude",
        args: [
          "--name",
          "my-session",
          "-n",
          "alias",
          "--debug-file",
          "/tmp/claude.log",
          "--tools",
          "Bash,Edit",
          "fix the build",
        ],
        agentSession: { provider: "claude", sessionId: "s-1" },
      }),
    );

    expect(plan).toEqual({
      kind: "command",
      command: "claude",
      args: [
        "--name",
        "my-session",
        "-n",
        "alias",
        "--debug-file",
        "/tmp/claude.log",
        "--tools",
        "Bash,Edit",
        "--resume",
        "s-1",
      ],
    });
  });

  it("drops an unknown flag together with the bare token after it", () => {
    const plan = planTerminalRelaunch(
      record({
        command: "claude",
        args: ["--future-flag", "value", "--other-future-flag", "--model", "opus"],
        agentSession: { provider: "claude", sessionId: "s-1" },
      }),
    );

    expect(plan).toEqual({
      kind: "command",
      command: "claude",
      args: ["--other-future-flag", "--model", "opus", "--resume", "s-1"],
    });
  });

  it("does not resume Codex when an unknown flag hides a non-interactive subcommand", () => {
    expect(
      planTerminalRelaunch(
        record({
          command: "codex",
          args: ["--future-flag", "exec", "write tests"],
          agentSession: { provider: "codex", sessionId: "codex-session" },
        }),
      ),
    ).toEqual({ kind: "command" });
  });

  it("stops reading flags at --", () => {
    const plan = planTerminalRelaunch(
      record({
        command: "claude",
        args: ["--model", "opus", "--", "--not-a-flag prompt"],
        agentSession: { provider: "claude", sessionId: "s-1" },
      }),
    );

    expect(plan).toEqual({
      kind: "command",
      command: "claude",
      args: ["--model", "opus", "--resume", "s-1"],
    });
  });

  it("replaces Claude session-selection flags with the known session", () => {
    const plan = planTerminalRelaunch(
      record({
        command: "claude",
        args: ["--continue", "--resume", "old-session", "--session-id", "older", "--fork-session"],
        agentSession: { provider: "claude", sessionId: "new-session" },
      }),
    );

    expect(plan).toEqual({ kind: "command", command: "claude", args: ["--resume", "new-session"] });
  });

  it("resumes Codex through its resume subcommand and keeps root flags", () => {
    const plan = planTerminalRelaunch(
      record({
        command: "codex",
        args: ["-c", 'model="o3"', "--yolo", "write tests"],
        agentSession: { provider: "codex", sessionId: "codex-session" },
      }),
    );

    expect(plan).toEqual({
      kind: "command",
      command: "codex",
      args: ["-c", 'model="o3"', "--yolo", "resume", "codex-session"],
    });
  });

  it("does not resume a non-interactive Codex subcommand", () => {
    expect(
      planTerminalRelaunch(
        record({
          command: "codex",
          args: ["exec", "--json", "write tests"],
          agentSession: { provider: "codex", sessionId: "codex-session" },
        }),
      ),
    ).toEqual({ kind: "command" });
  });

  it("resumes a Windows claude.cmd shim", () => {
    const plan = planTerminalRelaunch(
      record({
        command: "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
        args: ["--model", "opus"],
        agentSession: { provider: "claude", sessionId: "s-1" },
      }),
    );

    expect(plan).toEqual({
      kind: "command",
      command: "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
      args: ["--model", "opus", "--resume", "s-1"],
    });
  });

  it("types the resume command into a shell terminal the agent was started from", () => {
    expect(
      planTerminalRelaunch(record({ agentSession: { provider: "claude", sessionId: "abc-123" } })),
    ).toEqual({ kind: "shell-input", input: "claude --resume abc-123\r" });
    expect(
      planTerminalRelaunch(record({ agentSession: { provider: "codex", sessionId: "abc-123" } })),
    ).toEqual({ kind: "shell-input", input: "codex resume abc-123\r" });
  });

  it("refuses session ids that are unsafe to type into a shell", () => {
    expect(
      planTerminalRelaunch(
        record({ agentSession: { provider: "claude", sessionId: "x; rm -rf ~" } }),
      ),
    ).toEqual({ kind: "command" });
  });
});
