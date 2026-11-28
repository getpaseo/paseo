import { ZodRealError } from "zod";
import type { z } from "zod";
import {
  SessionOutboundMessageValidators,
  WSOutboundEnvelope,
} from "../generated/validation/ws-outbound.aot.js";
import type { SessionOutboundMessage, WSOutboundMessage } from "../messages.js";
import { omitUnsupportedWorkspaceTabs } from "./unsupported-workspace-tabs.js";

type ValidationResult<T> = { success: true; data: T } | { success: false; error: z.ZodError };

interface GeneratedValidator<T> {
  safeParse(input: unknown): ValidationResult<T>;
}

// zod-aot emits runtime JavaScript from the envelope and message schemas but not its TypeScript surface.
// Protocol regression tests cover the patched compiler cases behind this boundary.
const envelopeValidator = WSOutboundEnvelope as GeneratedValidator<WSOutboundMessage>;
const sessionMessageValidators = SessionOutboundMessageValidators as Record<
  SessionOutboundMessage["type"],
  GeneratedValidator<SessionOutboundMessage>
>;

// The message validator reports paths relative to the message, nested issues included.
function underMessage(issue: z.core.$ZodIssue): z.core.$ZodIssue {
  const path = ["message", ...issue.path];
  switch (issue.code) {
    case "invalid_union":
      return issue.inclusive === false
        ? { ...issue, path }
        : { ...issue, path, errors: issue.errors.map((branch) => branch.map(underMessage)) };
    case "invalid_key":
    case "invalid_element":
      return { ...issue, path, issues: issue.issues.map(underMessage) };
    default:
      return { ...issue, path };
  }
}

export function validateWSOutboundMessage(
  input: unknown,
  onUnsupportedWorkspaceTabs?: (messageType: SessionOutboundMessage["type"]) => void,
): ValidationResult<WSOutboundMessage> {
  const envelope = envelopeValidator.safeParse(input);
  if (!envelope.success || envelope.data.type !== "session") {
    return envelope;
  }
  const message = envelope.data.message;
  const validator = sessionMessageValidators[message.type];
  let result = validator.safeParse(message);
  // COMPAT(workspaceTabTargets): added for tab sync; keep older clients tolerant of new kinds.
  if (!result.success) {
    const filtered = omitUnsupportedWorkspaceTabs(message);
    if (filtered !== message) {
      result = validator.safeParse(filtered);
      if (result.success) onUnsupportedWorkspaceTabs?.(message.type);
    }
  }
  if (!result.success) {
    return { success: false, error: new ZodRealError(result.error.issues.map(underMessage)) };
  }
  // Message validators return a new object when they apply defaults.
  if (result.data === message) {
    return envelope;
  }
  return { success: true, data: { ...envelope.data, message: result.data } };
}
