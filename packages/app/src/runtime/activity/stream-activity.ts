/**
 * Client-observed stream activity, kept in a plain module-scope map.
 *
 * Deliberately NOT built on the coalesced `agentLastActivity` slice beside it
 * (`last-activity-coalescer.ts`): that one commits to the session store, and
 * `session-store.ts` feeds `lastActivityAt` into agent-list sorting, so a flush on every
 * stream event would re-sort the sidebar for the duration of every turn. That is exactly
 * the cascade the NOTE in the `agent_stream` handler warns against. Do not consolidate the
 * two — the whole point of this module is that writing to it costs zero React work.
 *
 * Values are client-clock timestamps (`Date.now()`), so they may only ever be combined with
 * another client-clock reading. Never subtract one of these from a daemon-supplied value.
 */

const lastStreamActivityAtByAgent = new Map<string, number>();

function key(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export function recordAgentStreamActivity(
  serverId: string,
  agentId: string,
  nowMs: number = Date.now(),
): void {
  // Monotonic: the stored value is the most recent activity ever observed, so a clock that
  // steps backwards (a laptop waking, an NTP correction) cannot make a live agent read as
  // more idle than it is.
  const entryKey = key(serverId, agentId);
  const previous = lastStreamActivityAtByAgent.get(entryKey);
  if (previous !== undefined && previous >= nowMs) return;
  lastStreamActivityAtByAgent.set(entryKey, nowMs);
}

export function readAgentStreamActivityAt(serverId: string, agentId: string): number | undefined {
  return lastStreamActivityAtByAgent.get(key(serverId, agentId));
}

export function forgetAgentStreamActivity(serverId: string, agentId: string): void {
  lastStreamActivityAtByAgent.delete(key(serverId, agentId));
}
