import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { executionDecision } from "./rpc";

export const captureContext = z.object({
  application: z.string().max(1000).optional(),
  bundleId: z.string().max(1000).optional(),
  windowTitle: z.string().max(4000).optional(),
  document: z.string().max(4000).optional(),
});
export const captureInput = z.object({
  key: z.uuid(),
  deviceId: z.uuid(),
  text: z.string().trim().min(1).max(64000),
  ocr: z.string().max(32000),
  context: captureContext,
  config: z.object({
    provider: z.string().min(1),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
  autoModel: z.boolean(),
  launchProfileId: z.string().optional(),
  images: z
    .array(z.object({ data: z.string().max(32 * 1024 * 1024), mimeType: z.literal("image/png") }))
    .min(1)
    .max(2),
});
export const captureDecision = z.object({
  projectId: z.string().nullable(),
  root: z.string(),
  reason: z.enum(["explicit", "jev", "fallback"]),
  execution: executionDecision.optional(),
});
export const captureRpc = defineRpc({
  name: "workflow.capture.create.request",
  input: captureInput,
  output: z.object({
    type: z.literal("workflow.capture.create.response"),
    workspaceId: z.string(),
    agentId: z.string(),
    destination: z.string(),
    classificationMs: z.number(),
    creationMs: z.number(),
  }),
});
export const captureSettings = defineSettings({
  id: "desktop-captures",
  scope: "host",
  version: 1,
  schema: z.object({
    requests: z
      .record(
        z.string(),
        z.object({
          fingerprint: z.string(),
          decision: captureDecision,
          workspaceId: z.string().optional(),
          agentId: z.string().optional(),
          classificationMs: z.number(),
        }),
      )
      .default({}),
  }),
});
