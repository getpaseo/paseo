import equal from "fast-deep-equal";
import type { AgentUsage } from "@getpaseo/protocol/agent-types";

interface AgentUpdateValue {
  updatedAt: Date | string;
  lastUsage?: AgentUsage;
}

function timestamp(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

export function acceptAgentDirectoryUpdate<T extends AgentUpdateValue>(
  current: T | undefined,
  incoming: T,
): T {
  if (!current || timestamp(incoming.updatedAt) >= timestamp(current.updatedAt)) return incoming;

  // From here down the incoming update is STALE — it describes an older state than what we
  // already hold. Usage is grafted forward anyway because a late usage event still describes
  // real consumption that the newer record may not have carried.
  //
  // Live turn progress (`activeTurnOutputTokens`, `activeTurnIdleMs` and its receipt instant) is
  // deliberately NOT grafted, and the check above is the whole reason it does not need to be:
  // the record we already hold was projected later, and the daemon rebuilds all three from live
  // state on every running snapshot, so a stale record's progress can only be equal or worse.
  // Writing it forward would let the count visibly regress mid-turn, resurrect a count the
  // provider had already cleared, or pair an old idle duration with an old receipt instant and
  // fabricate a stall the client never observed.
  if (incoming.lastUsage === undefined || equal(incoming.lastUsage, current.lastUsage)) {
    return current;
  }
  return { ...current, lastUsage: incoming.lastUsage };
}
