import equal from "fast-deep-equal";
import type { AgentUsage } from "@getpaseo/protocol/agent-types";

interface AgentUpdateValue {
  updatedAt: Date | string;
  lastUsage?: AgentUsage;
}

function timestamp(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * Every update arrives as a whole new agent, so each nested value (capabilities, modes, labels) is
 * a new object even when it did not change. Keep the current value for every field that is equal,
 * and the current agent when nothing changed, so a reader of one field sees a new value only when
 * that field changes.
 */
export function keepUnchangedAgentFields<T extends object>(current: T, incoming: T): T {
  const currentFields = current as Record<string, unknown>;
  const next = { ...incoming } as Record<string, unknown>;
  let changed = Object.keys(currentFields).length !== Object.keys(next).length;
  for (const key of Object.keys(next)) {
    if (next[key] === currentFields[key]) continue;
    if (key in currentFields && equal(next[key], currentFields[key])) {
      next[key] = currentFields[key];
    } else {
      changed = true;
    }
  }
  return changed ? (next as T) : current;
}

export function acceptAgentDirectoryUpdate<T extends AgentUpdateValue>(
  current: T | undefined,
  incoming: T,
): T {
  if (!current) return incoming;
  if (timestamp(incoming.updatedAt) >= timestamp(current.updatedAt)) {
    return keepUnchangedAgentFields(current, incoming);
  }
  if (incoming.lastUsage === undefined) return current;
  if (equal(incoming.lastUsage, current.lastUsage)) return current;
  return { ...current, lastUsage: incoming.lastUsage };
}
