import type { z } from "zod";
import { WSOutboundMessageSchema } from "../generated/validation/ws-outbound.aot.js";
import type { WSOutboundMessage } from "../messages.js";
import { normalizeWSOutboundMessage } from "./model-normalization.js";

type WSOutboundValidationResult =
  | { success: true; data: WSOutboundMessage }
  | { success: false; error: z.ZodError };

export function validateWSOutboundMessage(input: unknown): WSOutboundValidationResult {
  const parsed = WSOutboundMessageSchema.safeParse(input) as WSOutboundValidationResult;
  if (!parsed.success) {
    return parsed;
  }

  return { success: true, data: normalizeWSOutboundMessage(parsed.data) };
}
