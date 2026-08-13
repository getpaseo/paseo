import { describe, expect, it } from "vitest";
import {
  buildWorkspaceDraftAgentConfig,
  resolveWorkspaceDraftModeId,
} from "./workspace-draft-agent-config";

describe("workspace-draft-agent-config", () => {
  it("builds chat-only config for workspace draft agents", () => {
    expect(
      buildWorkspaceDraftAgentConfig({
        provider: "codex",
        cwd: "/tmp/project",
        modeId: "auto",
        model: "gpt-5.4",
        thinkingOptionId: "high",
      }),
    ).toEqual({
      provider: "codex",
      cwd: "/tmp/project",
      modeId: "auto",
      model: "gpt-5.4",
      thinkingOptionId: "high",
    });
  });
});

describe("resolveWorkspaceDraftModeId", () => {
  it("uses a valid selected mode", () => {
    const input = {
      requestedModeId: undefined,
      modeOptionIds: ["plan", "agent"],
      selectedModeId: "agent",
    };

    expect(resolveWorkspaceDraftModeId(input)).toBe("agent");
  });

  it("uses a valid requested mode", () => {
    expect(
      resolveWorkspaceDraftModeId({
        requestedModeId: "agent",
        modeOptionIds: ["plan", "agent"],
        selectedModeId: "plan",
      }),
    ).toBe("agent");
  });

  it("reconciles a requested mode with the provider modes", () => {
    expect(
      resolveWorkspaceDraftModeId({
        requestedModeId: "full-access",
        modeOptionIds: ["agent"],
        selectedModeId: "agent",
      }),
    ).toBe("agent");
  });

  it("omits a requested mode for a modeless provider", () => {
    const input = {
      requestedModeId: "agent",
      modeOptionIds: [],
      selectedModeId: "agent",
    };

    expect(
      buildWorkspaceDraftAgentConfig({
        provider: "pi",
        cwd: "/tmp/project",
        modeId: resolveWorkspaceDraftModeId(input),
      }),
    ).toEqual({
      provider: "pi",
      cwd: "/tmp/project",
    });
  });
});
