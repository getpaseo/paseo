import { describe, expect, it } from "vitest";
import { draftCreationKey } from "./creation-key";

const request = {
  config: { provider: "codex", cwd: "/repo", model: "gpt-6" },
  workspaceId: "workspace-1",
  initialPrompt: "Start the original task.",
  clientMessageId: "draft-1:initial-message",
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
});
