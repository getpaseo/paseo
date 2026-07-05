import type { z } from "zod";
import { WSOutboundMessageSchema } from "../generated/validation/ws-outbound.aot.js";
import type { WSOutboundMessage } from "../messages.js";

type WSOutboundValidationResult =
  | { success: true; data: WSOutboundMessage }
  | { success: false; error: z.ZodError };

interface WSOutboundGeneratedValidator {
  safeParse(input: unknown): WSOutboundValidationResult;
}

// zod-aot emits runtime JavaScript from WSOutboundMessageSchema but not its TypeScript surface.
// Protocol regression tests cover the patched compiler cases behind this boundary.
const wsOutboundValidator = WSOutboundMessageSchema as WSOutboundGeneratedValidator;

export function validateWSOutboundMessage(input: unknown): WSOutboundValidationResult {
  return wsOutboundValidator.safeParse(input);
}
