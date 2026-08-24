import type {
  TerminalExitEvent,
  TerminalManager,
  TerminalOutputEvent,
} from "../../terminal/terminal-manager.js";
import { TerminalServiceStore, type TerminalServiceCandidate } from "./terminal-service-store.js";

type ServiceFetch = typeof fetch;
type HealthProbe = (url: string) => Promise<boolean>;

export async function probeLocalService(
  url: string,
  options: { fetch?: ServiceFetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_500);
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export interface TerminalServiceObserver {
  store: TerminalServiceStore;
  dispose(): void;
}

export function observeTerminalServices(options: {
  terminalManager: TerminalManager;
  store?: TerminalServiceStore;
  probe?: HealthProbe;
  probeRetryDelayMs?: number;
  maxProbeAttempts?: number;
  onChange: (workspaceId: string) => void;
}): TerminalServiceObserver {
  const store = options.store ?? new TerminalServiceStore();
  const probe = options.probe ?? probeLocalService;
  let disposed = false;
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryDelayMs = options.probeRetryDelayMs ?? 1_000;
  const maxProbeAttempts = options.maxProbeAttempts ?? 10;

  const publish = (workspaceId: string) => {
    if (!disposed) options.onChange(workspaceId);
  };
  const clearRetry = (candidateId: string) => {
    const timer = retryTimers.get(candidateId);
    if (timer) clearTimeout(timer);
    retryTimers.delete(candidateId);
  };
  const scheduleRetry = (candidate: TerminalServiceCandidate, attempt: number) => {
    if (attempt >= maxProbeAttempts) return;
    clearRetry(candidate.id);
    retryTimers.set(
      candidate.id,
      setTimeout(() => {
        retryTimers.delete(candidate.id);
        const current = store.get(candidate.id);
        if (!disposed && current?.localUrl === candidate.localUrl) {
          probeCandidate(current, attempt + 1);
        }
      }, retryDelayMs),
    );
  };
  const probeCandidate = (candidate: TerminalServiceCandidate, attempt = 1) => {
    void probe(candidate.localUrl)
      .then((healthy) => {
        if (disposed) return undefined;
        const current = store.get(candidate.id);
        if (!current || current.localUrl !== candidate.localUrl) return undefined;
        store.setHealth(candidate.id, healthy);
        publish(candidate.workspaceId);
        if (healthy) clearRetry(candidate.id);
        else scheduleRetry(candidate, attempt);
        return undefined;
      })
      .catch(() => {
        const current = store.get(candidate.id);
        if (!disposed && current?.localUrl === candidate.localUrl) {
          store.setHealth(candidate.id, false);
          publish(candidate.workspaceId);
          scheduleRetry(candidate, attempt);
        }
      });
  };
  const handleOutput = (event: TerminalOutputEvent) => {
    const candidates = store.observeOutput(
      { terminalId: event.terminalId, workspaceId: event.workspaceId },
      event.data,
    );
    if (candidates.length === 0) return;
    publish(event.workspaceId);
    for (const candidate of candidates) {
      clearRetry(candidate.id);
      probeCandidate(candidate);
    }
  };
  const handleExit = (event: TerminalExitEvent) => {
    const removedIds = store.removeTerminal(event.terminalId);
    for (const id of removedIds) clearRetry(id);
    if (removedIds.length > 0) publish(event.workspaceId);
  };

  const unsubscribeOutput = options.terminalManager.subscribeTerminalOutput?.(handleOutput);
  const unsubscribeExit = options.terminalManager.subscribeTerminalExit?.(handleExit);
  return {
    store,
    dispose: () => {
      disposed = true;
      for (const id of retryTimers.keys()) clearRetry(id);
      unsubscribeOutput?.();
      unsubscribeExit?.();
    },
  };
}
