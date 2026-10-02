import { describe, expect, it } from "vitest";
import { buildWorkspaceDraftAgentConfig } from "./workspace-draft-agent-config";

describe("workspace-draft-agent-config", () => {
  it("grants routing only for an explicit Auto choice without changing the model", () => {
    const choice = {
      provider: "opencode",
      cwd: "/tmp/project",
      model: "opencode/muse-spark-1.3-contributor-free",
    };
    expect(buildWorkspaceDraftAgentConfig(choice)).toEqual(choice);
    expect(buildWorkspaceDraftAgentConfig({ ...choice, routingMode: "auto" })).toEqual({
      ...choice,
      labels: { "pandaos.routing.mode": "auto" },
    });
  });

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
