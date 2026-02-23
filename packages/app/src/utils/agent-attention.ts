interface ShouldClearAgentAttentionOnViewInput {
  agentId: string | null | undefined;
  focusedAgentId: string | null | undefined;
  isConnected: boolean;
  requiresAttention: boolean | null | undefined;
  attentionReason?: "finished" | "error" | "permission" | null | undefined;
}

export function shouldClearAgentAttentionOnView(
  input: ShouldClearAgentAttentionOnViewInput
): boolean {
  const agentId = input.agentId?.trim();
  if (!agentId) {
    return false;
  }
  if (!input.isConnected) {
    return false;
  }
  if (!input.requiresAttention) {
    return false;
  }
  if (input.attentionReason === "permission") {
    return false;
  }
  return input.focusedAgentId === agentId;
}
