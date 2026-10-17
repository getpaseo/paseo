import { createPaseoApi, type PaseoAgentConfig } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  formatDesktopCapturePrompt,
  type DesktopCaptureDraft,
} from "@getpaseo/protocol/desktop-capture";
import { z } from "zod";

export interface CaptureSubmission {
  key: string;
  deviceId: string;
  text: string;
  ocr: string;
  context: DesktopCaptureDraft["context"];
  config: PaseoAgentConfig;
  autoModel: boolean;
  launchProfileId?: string;
  images: Array<{ data: string; mimeType: string }>;
}
export const captureResultSchema = z.object({
  type: z.literal("workflow.capture.create.response"),
  workspaceId: z.string(),
  agentId: z.uuid(),
  destination: z.string(),
  classificationMs: z.number(),
  creationMs: z.number(),
});

export function createCaptureSubmitter() {
  const routes = new Map<string, "plugin" | "para">();
  return async (
    client: DaemonClient,
    input: CaptureSubmission,
    ensurePara: () => Promise<string>,
  ) => {
    let route = routes.get(input.key);
    if (!route) {
      const plugins = await client.listPlugins();
      route = plugins.some(
        (plugin) => plugin.id === "paseo-workflow" && plugin.status === "running",
      )
        ? "plugin"
        : "para";
      routes.set(input.key, route);
    }
    const agentPrompt = formatDesktopCapturePrompt(input);
    if (route === "plugin")
      return captureResultSchema.parse(
        await client.invokePluginRpc("paseo-workflow", "workflow.capture.create.request", {
          ...input,
          agentPrompt,
        }),
      );
    const start = performance.now();
    const directory = await ensurePara();
    const api = createPaseoApi(client);
    try {
      const workspace = await api.workspaces.open(directory);
      const agent = await workspace.agents.create({
        idempotencyKey: `capture:${input.key}:agent`,
        launchProfileId: input.launchProfileId,
        config: input.config,
        prompt: agentPrompt,
        clientMessageId: `capture:${input.key}:message`,
        images: input.images,
        labels: { "paseo.capture.id": input.key, "paseo.capture.device": input.deviceId },
      });
      return {
        type: "workflow.capture.create.response" as const,
        workspaceId: workspace.id,
        agentId: agent.id,
        destination: directory,
        classificationMs: 0,
        creationMs: performance.now() - start,
      };
    } finally {
      await api.dispose();
    }
  };
}
