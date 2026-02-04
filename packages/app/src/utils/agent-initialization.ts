export interface DeferredInit {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

const initPromises = new Map<string, DeferredInit>();

export function getInitKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export function getInitDeferred(key: string): DeferredInit | undefined {
  return initPromises.get(key);
}

export function createInitDeferred(key: string): DeferredInit {
  let resolve!: () => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const deferred: DeferredInit = { promise, resolve, reject };
  initPromises.set(key, deferred);
  return deferred;
}

export function resolveInitDeferred(key: string): void {
  const deferred = initPromises.get(key);
  deferred?.resolve();
}

export function rejectInitDeferred(key: string, error: Error): void {
  const deferred = initPromises.get(key);
  if (!deferred) {
    return;
  }
  initPromises.delete(key);
  deferred.reject(error);
}

