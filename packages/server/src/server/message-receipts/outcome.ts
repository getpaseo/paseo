import { z } from "zod";
import { AgentTurnStartCanceledError } from "../agent/agent-sdk-types.js";

const FailureOutcome = z.enum(["not_submitted", "rejected", "unknown"]);
export type DeliveryFailureOutcome = z.infer<typeof FailureOutcome>;

export class MessageDeliveryError extends Error {
  readonly deliveryOutcome: DeliveryFailureOutcome;
  constructor(input: { outcome: DeliveryFailureOutcome; message?: string; cause?: unknown }) {
    super(
      input.message ?? (input.cause instanceof Error ? input.cause.message : String(input.cause)),
      { cause: input.cause },
    );
    this.deliveryOutcome = input.outcome;
  }
}

export function deliveryFailureOutcome(
  error: unknown,
  fallback: DeliveryFailureOutcome = "unknown",
): DeliveryFailureOutcome {
  if (error instanceof AgentTurnStartCanceledError) return "not_submitted";
  if (error instanceof Error && "deliveryOutcome" in error) {
    const result = FailureOutcome.safeParse(error.deliveryOutcome);
    if (result.success) return result.data;
  }
  return fallback;
}
