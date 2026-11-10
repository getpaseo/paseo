import { describe, expect, it } from "vitest";
import { retriedAgentRequest, type WorkspaceAgentRequest } from "./retry-agent-request";

const initial: WorkspaceAgentRequest = {
  config: { provider: "codex", cwd: "/repo", model: "gpt-6" },
  metadata: { "issues.key": "PAS-1" },
  initialPrompt: "first try",
  clientMessageId: "draft_1:initial-message",
};

describe("retriedAgentRequest", () => {
  it("creates with the metadata the draft resubmitted", () => {
    const retried = retriedAgentRequest(
      initial,
      {
        config: { provider: "codex", cwd: "/repo", model: "gpt-6" },
        initialPrompt: "second try",
        metadata: { "issues.key": "PAS-2" },
      },
      "/repo",
    );
    expect(retried.metadata).toEqual({ "issues.key": "PAS-2" });
    expect(retried.initialPrompt).toBe("second try");
    expect(retried.clientMessageId).toBe("draft_1:initial-message");
  });

  it("creates with no metadata once the draft cleared it", () => {
    const retried = retriedAgentRequest(
      initial,
      { config: { provider: "codex", cwd: "/repo", model: "gpt-6" }, initialPrompt: "second try" },
      "/repo",
    );
    expect("metadata" in retried).toBe(false);
  });

  it("keeps the first attempt's directory over the resubmitted config", () => {
    const retried = retriedAgentRequest(
      initial,
      {
        config: { provider: "codex", cwd: "/elsewhere", model: "gpt-6-mini" },
        initialPrompt: "second try",
      },
      "/repo",
    );
    expect(retried.config).toEqual({ provider: "codex", cwd: "/repo", model: "gpt-6-mini" });
  });
});
