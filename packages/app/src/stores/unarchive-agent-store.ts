export interface UnarchiveAgentTarget {
  serverId: string;
  agentId: string;
}

const pendingUnarchiveTokens = new Map<string, number>();
const listeners = new Set<() => void>();
let nextAttemptToken = 1;

function toUnarchiveKey(input: UnarchiveAgentTarget): string {
  const serverId = input.serverId.trim();
  const agentId = input.agentId.trim();
  if (!serverId || !agentId) return "";
  return `${serverId}:${agentId}`;
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

export function subscribeUnarchiveAgentPending(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Starts a scoped unarchive attempt and returns a token for `finishAgentUnarchive`. */
export function beginAgentUnarchive(input: UnarchiveAgentTarget): number {
  const key = toUnarchiveKey(input);
  if (!key) return 0;
  const token = nextAttemptToken++;
  pendingUnarchiveTokens.set(key, token);
  notifyListeners();
  return token;
}

/** Clears the pending state only if `token` still owns the latest attempt for this agent. */
export function finishAgentUnarchive(input: UnarchiveAgentTarget, token: number): void {
  const key = toUnarchiveKey(input);
  if (!key || token === 0) return;
  if (pendingUnarchiveTokens.get(key) !== token) return;
  pendingUnarchiveTokens.delete(key);
  notifyListeners();
}

export function clearUnarchiveAgentPending(input: UnarchiveAgentTarget): void {
  const key = toUnarchiveKey(input);
  if (!key || !pendingUnarchiveTokens.delete(key)) return;
  notifyListeners();
}

export function clearUnarchiveAgentPendingForServer(serverId: string): void {
  const trimmed = serverId.trim();
  if (!trimmed) return;
  const prefix = `${trimmed}:`;
  let changed = false;
  for (const key of pendingUnarchiveTokens.keys()) {
    if (key.startsWith(prefix)) {
      pendingUnarchiveTokens.delete(key);
      changed = true;
    }
  }
  if (changed) notifyListeners();
}

export function isAgentUnarchiving(input: UnarchiveAgentTarget): boolean {
  const key = toUnarchiveKey(input);
  return key ? pendingUnarchiveTokens.has(key) : false;
}
