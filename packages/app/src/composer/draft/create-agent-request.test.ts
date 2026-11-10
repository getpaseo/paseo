import { describe, expect, it, vi } from "vitest";
import { requestWorkspaceDraftAgent } from "./create-agent-request";

vi.mock("@/utils/encode-images", () => ({
  encodeImages: vi.fn(async () => undefined),
}));

describe("requestWorkspaceDraftAgent", () => {
  it("forwards stable labels and clientMessageId to the native create request", async () => {
    const createAgent = vi.fn(async () => ({ id: "agent-1" }));
    const client = { createAgent } as never;
    await requestWorkspaceDraftAgent(client, {
      workspaceId: "workspace-1",
      config: { provider: "codex", cwd: "/workspace" },
      text: "final composer text",
      clientMessageId: "message-1",
      labels: {
        "paseo.plugin.todo": "v1",
        "paseo.plugin.todo.work-item-id": "work-1",
        "paseo.plugin.todo.attempt-id": "attempt-1",
      },
    });
    expect(createAgent).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      config: { provider: "codex", cwd: "/workspace" },
      initialPrompt: "final composer text",
      clientMessageId: "message-1",
      labels: {
        "paseo.plugin.todo": "v1",
        "paseo.plugin.todo.work-item-id": "work-1",
        "paseo.plugin.todo.attempt-id": "attempt-1",
      },
    });
  });
});
