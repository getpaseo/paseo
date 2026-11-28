import equal from "fast-deep-equal";
import type { AgentMetric, AgentUsage } from "@getpaseo/protocol/agent-types";

interface AgentUpdateValue {
  updatedAt: Date | string;
  lastUsage?: AgentUsage;
  sessionMetrics?: AgentMetric[];
}

// The daemon reports these without bumping `updatedAt`, so a stale upsert can still carry the
// newest value.
const FIELDS_UPDATED_IN_PLACE = ["lastUsage", "sessionMetrics"] as const;

function timestamp(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

export function acceptAgentDirectoryUpdate<T extends AgentUpdateValue>(
  current: T | undefined,
  incoming: T,
): T {
  if (!current || timestamp(incoming.updatedAt) >= timestamp(current.updatedAt)) return incoming;
  const newer = FIELDS_UPDATED_IN_PLACE.filter(
    (field) => incoming[field] !== undefined && !equal(incoming[field], current[field]),
  );
  if (newer.length === 0) return current;
  return { ...current, ...Object.fromEntries(newer.map((field) => [field, incoming[field]])) };
}
