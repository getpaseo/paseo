import { describe, expect, it } from "vitest";
import {
  retriedAgentRequest,
  retryWorkspaceAgentCreation,
  type WorkspaceAgentRequest,
} from "./retry-agent-request";
import { AgentSnapshotPayloadSchema } from "@getpaseo/protocol/messages";
import { keyedDraftAgentRequest } from "@/composer/draft/creation-key";

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

describe("workspace agent creation retries", () => {
  const agent = AgentSnapshotPayloadSchema.parse({
    id: "agent-one",
    provider: "codex",
    cwd: "/repo/worktree",
    status: "idle",
    model: null,
    lastUserMessageAt: null,
    createdAt: "2026-11-13T00:00:00Z",
    updatedAt: "2026-11-13T00:00:00Z",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: "Retried agent",
    labels: {},
  });

  it.each([
    { name: "unchanged retry", prompt: "first try", expectedCalls: ["workspace"] },
    { name: "edited submission", prompt: "new task", expectedCalls: ["agent"] },
  ])("preserves the ready workspace on $name", async ({ prompt, expectedCalls }) => {
    const calls: string[] = [];
    const request = await keyedDraftAgentRequest("draft_1", {
      ...initial,
      config: { ...initial.config!, cwd: "/repo/worktree" },
      workspaceId: "existing-workspace",
      initialPrompt: prompt,
    });
    const result = await retryWorkspaceAgentCreation({
      initial,
      request,
      cwd: "/repo",
      retryOriginal: async () => {
        calls.push("workspace");
        return agent;
      },
      createAgent: async (agentRequest) => {
        calls.push("agent");
        expect(agentRequest).toEqual(request);
        return agent;
      },
    });
    expect(result).toEqual(agent);
    expect(calls).toEqual(expectedCalls);
  });
});
