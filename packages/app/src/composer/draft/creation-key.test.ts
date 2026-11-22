import { describe, expect, it } from "vitest";
import { draftCreationKey } from "./creation-key";

const request = {
  config: { provider: "codex", cwd: "/repo", model: "gpt-6" },
  workspaceId: "workspace-1",
  initialPrompt: "Start the original task.",
  clientMessageId: "draft-1:initial-message",
};

const workspaceRequest = {
  source: {
    kind: "worktree" as const,
    cwd: "/repo",
    projectId: "prj_1",
    worktreeSlug: "clever-fox",
  },
  firstAgentContext: { prompt: "Start the original task.", attachments: [] },
  agent: {
    config: { provider: "codex", cwd: "/repo", model: "gpt-6" },
    initialPrompt: "Start the original task.",
    clientMessageId: "draft-1:initial-message",
  },
};

describe("draftCreationKey", () => {
  it("keeps the key for a retry of the same request, whatever its key order", () => {
    const reordered = {
      clientMessageId: request.clientMessageId,
      initialPrompt: request.initialPrompt,
      workspaceId: request.workspaceId,
      config: { model: "gpt-6", cwd: "/repo", provider: "codex" },
    };
    expect(draftCreationKey("draft-1", reordered)).toBe(draftCreationKey("draft-1", request));
  });

  it.each([
    { name: "prompt", edited: { ...request, initialPrompt: "Start the edited task." } },
    { name: "model", edited: { ...request, config: { ...request.config, model: "gpt-6-mini" } } },
  ])("gives an edited $name a new key on the same draft", ({ edited }) => {
    const key = draftCreationKey("draft-1", edited);
    expect(key).not.toBe(draftCreationKey("draft-1", request));
    expect(key.startsWith("draft-1:")).toBe(true);
  });

  it.each([
    {
      name: "isolation",
      edited: {
        ...workspaceRequest,
        source: { kind: "directory" as const, path: "/repo", projectId: "prj_1" },
      },
    },
    {
      name: "project",
      edited: {
        ...workspaceRequest,
        source: { ...workspaceRequest.source, projectId: "prj_2", cwd: "/other" },
      },
    },
    {
      name: "prompt",
      edited: {
        ...workspaceRequest,
        firstAgentContext: { prompt: "hi", attachments: [] },
        agent: { ...workspaceRequest.agent, initialPrompt: "hi" },
      },
    },
  ])(
    "gives a New workspace request with edited $name a new key on the same draft",
    ({ edited }) => {
      const key = draftCreationKey("draft-1", edited);
      expect(key).not.toBe(draftCreationKey("draft-1", workspaceRequest));
      expect(key.startsWith("draft-1:")).toBe(true);
    },
  );

  it("gives a New workspace request with a changed launch target a new key even when the wire request matches", () => {
    const emptyRequest = {
      source: { kind: "directory" as const, path: "/repo", projectId: "prj_1" },
    };
    const chatKey = draftCreationKey("draft-1", {
      request: emptyRequest,
      launchTarget: { kind: "chat" },
    });
    const terminalKey = draftCreationKey("draft-1", {
      request: emptyRequest,
      launchTarget: { kind: "terminal", profileId: "shell" },
    });
    expect(terminalKey).not.toBe(chatKey);
    expect(terminalKey.startsWith("draft-1:")).toBe(true);
  });
});
