import equal from "fast-deep-equal";
import type { AgentPromptCacheStatus, AgentUsage } from "@getpaseo/protocol/agent-types";

interface AgentUpdateValue {
  updatedAt: Date | string;
  lastUsage?: AgentUsage;
  promptCache?: AgentPromptCacheStatus;
}

function timestamp(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

// Usage and prompt-cache figures ride along on whatever snapshot the daemon happened
// to send, so a stale update can still carry the freshest numbers. Take those two
// fields from a stale update without letting the rest of it regress the entry.
export function acceptAgentDirectoryUpdate<T extends AgentUpdateValue>(
  current: T | undefined,
  incoming: T,
): T {
  if (!current || timestamp(incoming.updatedAt) >= timestamp(current.updatedAt)) return incoming;
  let next = current;
  if (incoming.lastUsage !== undefined && !equal(incoming.lastUsage, current.lastUsage)) {
    next = { ...next, lastUsage: incoming.lastUsage };
  }
  if (incoming.promptCache !== undefined && !equal(incoming.promptCache, current.promptCache)) {
    next = { ...next, promptCache: incoming.promptCache };
  }
  return next;
}
