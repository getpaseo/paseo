import { randomBytes } from "node:crypto";

/**
 * Turn ids stay unique for an agent's whole life. The daemon keeps every turn's rows while
 * idle runtime collection closes the provider session, and the next prompt reopens the agent
 * as a new session instance whose ordinals start over. Each instance therefore mixes its own
 * nonce into the ids it issues; the ordinal keeps the sequence readable in logs and tests.
 */
export function createTurnIdSequence(firstOrdinal: number): (owner: string) => string {
  const instance = randomBytes(6).toString("hex");
  let ordinal = firstOrdinal;
  return (owner) => `${owner}-turn-${instance}-${ordinal++}`;
}
