import type { z } from "zod";
import { WSOutboundMessageSchema } from "../generated/validation/ws-outbound.aot.js";
import type { WSOutboundMessage } from "../messages.js";
import { normalizeWSOutboundMessage } from "./model-normalization.js";

type WSOutboundValidationResult =
  | { success: true; data: WSOutboundMessage }
  | { success: false; error: z.ZodError };

type GeneratedValidationResult =
  | { success: true; data: unknown }
  | { success: false; error: z.ZodError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGeneratedValidationResult(value: unknown): value is GeneratedValidationResult {
  if (!isRecord(value) || typeof value.success !== "boolean") {
    return false;
  }

  return value.success ? Object.hasOwn(value, "data") : Object.hasOwn(value, "error");
}

export function validateWSOutboundMessage(input: unknown): WSOutboundValidationResult {
  const parsed: unknown = WSOutboundMessageSchema.safeParse(input);
  if (!isGeneratedValidationResult(parsed)) {
    throw new Error("Generated WS outbound validator returned an invalid safeParse result");
  }

  if (!parsed.success) {
    return parsed;
  }

  return {
    success: true,
    data: normalizeWSOutboundMessage(parsed.data as WSOutboundMessage),
  };
}
