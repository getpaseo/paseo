import type { SessionInboundMessage } from "../messages.js";

/** Raised when a principal asks for an agent mode its credential denies. */
export class AgentModeDeniedError extends Error {
  readonly code = "mode_denied";

  constructor(readonly modeId: string) {
    super(`Agent mode '${modeId}' is not allowed for this credential`);
    this.name = "AgentModeDeniedError";
  }
}

export function assertAgentModeAllowed(
  modeId: string | null | undefined,
  deniedModes: readonly string[] | undefined,
): void {
  if (modeId && deniedModes?.includes(modeId)) throw new AgentModeDeniedError(modeId);
}

/**
 * The mode an inbound request switches an existing agent to. Creation and resume
 * are checked against the resolved mode where it is known, so provider defaults,
 * inherited modes, and persisted modes are covered too.
 */
export function requestedModeForInbound(msg: SessionInboundMessage): string | undefined {
  switch (msg.type) {
    case "set_agent_mode_request":
      return msg.modeId;
    case "agent.config.apply.request":
      return msg.config.modeId;
    default:
      return undefined;
  }
}
