import { toDiagnosticErrorMessage } from "./diagnostic-utils.js";

export interface PiSessionRecoveryPolicySession {
  readonly messages: readonly PiRecoveryMessage[];
  readonly agent: {
    readonly state: {
      readonly errorMessage?: string | null;
    };
  };
  compact(): Promise<unknown>;
}

interface PiRecoveryMessage {
  readonly role: string;
  readonly stopReason?: string;
  readonly errorMessage?: string | null;
}

type PiSessionRecoveryPolicyId = "piCopilot413";

interface PiSessionRecoveryPolicy {
  readonly id: PiSessionRecoveryPolicyId;
  shouldRecover(session: PiSessionRecoveryPolicySession): boolean;
  recover(session: PiSessionRecoveryPolicySession): Promise<void>;
}

export interface PiSessionRecoveryResult {
  readonly applied: boolean;
  readonly policyId?: PiSessionRecoveryPolicyId;
}

// COMPAT(piCopilot413): added 2026-05-13 for Pi <= 0.73.1; target removal
// 2026-11-13, once upstream @mariozechner/pi-ai recognizes this overflow.
const PI_COPILOT_SHORT_413_OVERFLOW_PATTERN = /^413\s+failed to parse request$/i;

const PI_SESSION_RECOVERY_POLICIES: readonly PiSessionRecoveryPolicy[] = [
  {
    id: "piCopilot413",
    shouldRecover: shouldCompactForPiCopilot413,
    recover: compactPiSession,
  },
];

export async function applyPiSessionRecoveryPolicy(
  session: PiSessionRecoveryPolicySession,
): Promise<PiSessionRecoveryResult> {
  const policy = PI_SESSION_RECOVERY_POLICIES.find((entry) => entry.shouldRecover(session));
  if (!policy) {
    return { applied: false };
  }

  await policy.recover(session);
  return { applied: true, policyId: policy.id };
}

function shouldCompactForPiCopilot413(session: PiSessionRecoveryPolicySession): boolean {
  return (
    isPiCopilotShort413Overflow(getLatestAssistantErrorMessage(session)) ||
    isPiCopilotShort413Overflow(session.agent.state.errorMessage)
  );
}

function isPiCopilotShort413Overflow(errorMessage: string | null | undefined): boolean {
  const normalized = errorMessage?.trim();
  return normalized ? PI_COPILOT_SHORT_413_OVERFLOW_PATTERN.test(normalized) : false;
}

function getLatestAssistantErrorMessage(session: PiSessionRecoveryPolicySession): string | null {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    return message.stopReason === "error" ? (message.errorMessage?.trim() ?? null) : null;
  }
  return null;
}

async function compactPiSession(session: PiSessionRecoveryPolicySession): Promise<void> {
  try {
    await session.compact();
  } catch (error) {
    if (!isHarmlessPiCompactionError(error)) {
      throw error;
    }
  }
}

function isHarmlessPiCompactionError(error: unknown): boolean {
  return /already compacted|nothing to compact/i.test(toDiagnosticErrorMessage(error));
}
