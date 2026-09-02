import { describe, expect, it } from "vitest";
import { buildWorkspaceDraftAgentConfig } from "./workspace-draft-agent-config";

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

  it("preserves managed and explicit system account selections", () => {
    expect(
      buildWorkspaceDraftAgentConfig({
        provider: "codex",
        cwd: "/tmp/project",
        accountProfileId: "pac_0123456789abcdef",
      }).accountProfileId,
    ).toBe("pac_0123456789abcdef");
    expect(
      buildWorkspaceDraftAgentConfig({
        provider: "codex",
        cwd: "/tmp/project",
        accountProfileId: null,
      }).accountProfileId,
    ).toBeNull();
    expect(
      buildWorkspaceDraftAgentConfig({ provider: "codex", cwd: "/tmp/project" }),
    ).not.toHaveProperty("accountProfileId");
  });
});
