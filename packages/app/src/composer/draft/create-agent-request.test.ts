import { expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { requestWorkspaceDraftAgent } from "./create-agent-request";

it("creates and sends a workspace draft idempotently", async () => {
  const createAgent = vi.fn().mockResolvedValue({ id: "router-agent" });
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const config = {
    provider: "codex",
    cwd: "/workspace",
    model: "gpt-6-astra",
    modeId: "full-access",
    thinkingOptionId: "high",
    featureValues: { plan_mode: true },
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

it("routes Auto through creation without changing the first message", async () => {
  const createAgent = vi.fn().mockResolvedValue({ id: "router-agent" });
  const sendMessage = vi.fn().mockResolvedValue(undefined);

  await requestWorkspaceDraftAgent({ createAgent, sendMessage } as unknown as DaemonClient, {
    workspaceId: "workspace",
    modelRouting: "jev",
    config: { provider: "codex", cwd: "/workspace" },
    text: "Build a calendar",
    clientMessageId: "message",
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({ modelRouting: { strategy: "jev", prompt: "Build a calendar" } }),
  );
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith("router-agent", "Build a calendar", {
    messageId: "message",
  });
});
