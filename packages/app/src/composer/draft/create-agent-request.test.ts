import { expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { requestWorkspaceDraftAgent } from "./create-agent-request";

it("creates and sends a workspace draft idempotently", async () => {
  const createAgent = vi.fn().mockResolvedValue({ id: "router-agent" });
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const config = {
    provider: "codex",
    cwd: "/workspace",
    model: "gpt-5",
    modeId: "plan",
    thinkingOptionId: "high",
    featureValues: { webSearch: true },
  };
  await expect(
    requestWorkspaceDraftAgent({ createAgent, sendMessage } as unknown as DaemonClient, {
      workspaceId: "workspace",
      launchProfileId: "paseo-workflow-router",
      config,
      text: "Build a calendar",
      clientMessageId: "message",
      attachments: [{ type: "text", mimeType: "text/plain", text: "Calendar constraints" }],
    }),
  ).resolves.toEqual({ id: "router-agent" });
  expect(createAgent).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "workspace",
    launchProfileId: "paseo-workflow-router",
    config,
    idempotencyKey: "message:agent",
  });
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith("router-agent", "Build a calendar", {
    messageId: "message",
    attachments: [{ type: "text", mimeType: "text/plain", text: "Calendar constraints" }],
  });
});
