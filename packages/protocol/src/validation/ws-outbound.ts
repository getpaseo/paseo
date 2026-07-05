import type { z } from "zod";
import { WSOutboundMessageSchema } from "../generated/validation/ws-outbound.aot.js";
import type { WSOutboundMessage } from "../messages.js";
import { normalizeWSOutboundMessage } from "./model-normalization.js";

type WSOutboundValidationResult =
  | { success: true; data: WSOutboundMessage }
  | { success: false; error: z.ZodError };

interface WSOutboundGeneratedValidator {
  safeParse(input: unknown): WSOutboundValidationResult;
}

// zod-aot emits runtime JavaScript from WSOutboundMessageSchema but not its TypeScript surface.
// The differential tests keep that generated boundary honest against the Zod source schema.
const wsOutboundValidator = WSOutboundMessageSchema as WSOutboundGeneratedValidator;

export function validateWSOutboundMessage(input: unknown): WSOutboundValidationResult {
  const parsed = wsOutboundValidator.safeParse(input);
  if (!parsed.success) {
    return parsed;
  }

  return {
    success: true,
    data: normalizeWSOutboundMessage(parsed.data),
  };
}
