/** Admission was refused before the provider could receive this prompt. */
export class AgentBusyError extends Error {
  readonly code = "agent_busy";
  constructor(readonly agentId: string) {
    super("agent_busy");
    this.name = "AgentBusyError";
  }
}
