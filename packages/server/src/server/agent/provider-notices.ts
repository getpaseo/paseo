import type { AgentProviderNotice } from "./agent-sdk-types.js";

export const MODE_APPLIES_NEXT_TURN_NOTICE: AgentProviderNotice = {
  type: "warning",
  message: "Permission mode applies next turn",
};

export const THINKING_APPLIES_NEXT_TURN_NOTICE: AgentProviderNotice = {
  type: "warning",
  message: "Thinking level applies next turn",
};
