import { describe, expect, it } from "vitest";
import { deriveWorkspaceTabAgentManagementState } from "@/screens/workspace/workspace-agent-management";

describe("deriveWorkspaceTabAgentManagementState", () => {
  it("marks closed codex-process sessions as recoverable with tmux resume copy", () => {
    const result = deriveWorkspaceTabAgentManagementState({
      status: "closed",
      archivedAt: null,
      persistence: {
        provider: "codex",
        sessionId: "sess-123",
        metadata: {
          externalSessionSource: "codex_process",
        },
      },
      runtimeInfo: {
        provider: "codex",
        sessionId: "/dev/pts/15",
        extra: {
          externalSessionSource: "codex_process",
        },
      },
    });

    expect(result.badges).toEqual([{ key: "recoverable", label: "Recoverable", tone: "warning" }]);
    expect(result.reloadLabel).toBe("Resume in tmux");
    expect(result.reloadTooltip).toBe(
      "Paseo will relaunch this closed external Codex session inside tmux so the phone can manage it again.",
    );
  });

  it("uses tmux reopen copy for closed tmux-backed sessions", () => {
    const result = deriveWorkspaceTabAgentManagementState({
      status: "closed",
      archivedAt: null,
      persistence: {
        provider: "codex",
        sessionId: "%9",
        metadata: {
          externalSessionSource: "tmux_codex",
        },
      },
      runtimeInfo: {
        provider: "codex",
        sessionId: "%9",
        extra: {
          externalSessionSource: "tmux_codex",
        },
      },
    });

    expect(result.badges).toEqual([{ key: "recoverable", label: "Recoverable", tone: "warning" }]);
    expect(result.reloadLabel).toBe("Reopen tmux session");
    expect(result.reloadTooltip).toBe(
      "Paseo will reopen a tmux-backed Codex terminal from the recorded workspace.",
    );
  });

  it("keeps live sessions on the default reload copy", () => {
    const result = deriveWorkspaceTabAgentManagementState({
      status: "running",
      archivedAt: null,
      persistence: {
        provider: "codex",
        sessionId: "%9",
        metadata: {
          externalSessionSource: "tmux_codex",
        },
      },
      runtimeInfo: {
        provider: "codex",
        sessionId: "%9",
        extra: {
          externalSessionSource: "tmux_codex",
        },
      },
    });

    expect(result.badges).toEqual([]);
    expect(result.reloadLabel).toBe("Reload agent");
    expect(result.reloadTooltip).toBe("Reload agent to update skills, MCPs or login status.");
  });

  it("falls back safely when no agent metadata is available", () => {
    const result = deriveWorkspaceTabAgentManagementState(null);

    expect(result.badges).toEqual([]);
    expect(result.reloadLabel).toBe("Reload agent");
    expect(result.reloadTooltip).toBe("Reload agent to update skills, MCPs or login status.");
  });
});
