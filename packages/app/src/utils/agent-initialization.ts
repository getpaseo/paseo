export interface DeferredInit {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
  requestDirection: "tail" | "after";
}

const initPromises = new Map<string, DeferredInit>();
export const INIT_TIMEOUT_MS = 65_000;

export function getInitKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export function getInitDeferred(key: string): DeferredInit | undefined {
  return initPromises.get(key);
}

export function createInitDeferred(key: string, requestDirection: "tail" | "after"): DeferredInit {
  let resolve!: () => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const deferred: DeferredInit = {
    promise,
    resolve,
    reject,
    timeoutId: null,
    requestDirection,
  };
  initPromises.set(key, deferred);
  return deferred;
}

export function refreshInitTimeout(input: {
  key: string;
  onTimeout: () => void;
  timeoutMs?: number;
}): void {
  const timeoutId = setTimeout(input.onTimeout, input.timeoutMs ?? INIT_TIMEOUT_MS);
  const deferred = initPromises.get(input.key);
  if (!deferred) {
    clearTimeout(timeoutId);
    return;
  }
  if (deferred.timeoutId) {
    clearTimeout(deferred.timeoutId);
  }
  deferred.timeoutId = timeoutId;
}

export function resolveInitDeferred(key: string): void {
  const deferred = initPromises.get(key);
  if (!deferred) {
    return;
  }
  if (deferred.timeoutId) {
    clearTimeout(deferred.timeoutId);
  }
  initPromises.delete(key);
  deferred.resolve();
}

export function rejectInitDeferred(key: string, error: Error): void {
  const deferred = initPromises.get(key);
  if (!deferred) {
    return;
  }
  if (deferred.timeoutId) {
    clearTimeout(deferred.timeoutId);
  }
  initPromises.delete(key);
  deferred.reject(error);
}
