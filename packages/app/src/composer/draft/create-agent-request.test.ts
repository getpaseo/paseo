import { expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { requestWorkspaceDraftAgent } from "./create-agent-request";

it("sends launch provenance alongside the materialized draft config only on submit", async () => {
  const createAgent = vi.fn().mockResolvedValue({ id: "router-agent" });
  const config = {
    provider: "codex",
    cwd: "/workspace",
    model: "gpt-5",
    modeId: "plan",
    thinkingOptionId: "high",
    featureValues: { webSearch: true },
  };
  await expect(
    requestWorkspaceDraftAgent({ createAgent } as unknown as DaemonClient, {
      workspaceId: "workspace",
      launchProfileId: "paseo-workflow-router",
      config,
      text: "Build a calendar",
      clientMessageId: "message",
    }),
  ).resolves.toEqual({ id: "router-agent" });
  expect(createAgent).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "workspace",
    launchProfileId: "paseo-workflow-router",
    config,
    initialPrompt: "Build a calendar",
    clientMessageId: "message",
  });
});
