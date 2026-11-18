import {
  describeInvalidAgentResourcePolicy,
  isEmptyAgentResourcePolicy,
  type AgentResourceControl,
  type AgentResourcePolicy,
} from "@getpaseo/protocol/agent-resources";

/** A policy whose fields are each valid but contradict one another. */
export class InvalidAgentResourcePolicyError extends Error {
  constructor(public readonly reason: string) {
    super(`Invalid resource policy: ${reason}`);
    this.name = "InvalidAgentResourcePolicyError";
  }
}

/** One control of a policy that cannot be enforced, and why. */
export interface UnenforceableControl {
  control: AgentResourceControl;
  /** `unsupported`: the host or provider cannot do it. `denied`: the daemon may not. */
  state: "unsupported" | "denied";
  message: string;
}

/**
 * A policy this host or the agent's provider cannot enforce. It is thrown before
 * anything is stored or started: a limit is either in force or refused.
 */
export class UnenforceableAgentResourcePolicyError extends Error {
  constructor(public readonly controls: readonly UnenforceableControl[]) {
    const reasons = controls.map(({ control, message }) => `${control}: ${message}`);
    super(`Cannot enforce the resource policy. ${reasons.join("; ")}`);
    this.name = "UnenforceableAgentResourcePolicyError";
  }
}

/** Why an agent-scoped caller may not set or change a resource policy. */
export const AGENT_RESOURCE_POLICY_DENIED =
  "Agents cannot set resource policies; agents you create inherit your own";

/** The policy to store: undefined when it sets nothing. Throws when its fields contradict. */
export function normalizeAgentResourcePolicy(
  policy: AgentResourcePolicy | null | undefined,
): AgentResourcePolicy | undefined {
  if (!policy || isEmptyAgentResourcePolicy(policy)) {
    return undefined;
  }
  const invalid = describeInvalidAgentResourcePolicy(policy);
  if (invalid) {
    throw new InvalidAgentResourcePolicyError(invalid);
  }
  return policy;
}
