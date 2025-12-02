import { getNowMs, isPerfLoggingEnabled, perfLog } from "@/utils/perf";

type NavigationTimingDetails = {
  from: string;
  to: string;
  params?: Record<string, unknown>;
  targetMs?: number;
};

type NavigationTimingEntry = NavigationTimingDetails & {
  startedAt: number;
};

const NAVIGATION_TAG = "[NavigationTiming]";
const pendingNavigations = new Map<string, NavigationTimingEntry>();

export const HOME_NAVIGATION_KEY = "home";

export const buildAgentNavigationKey = (serverId: string, agentId: string) =>
  `agent:${serverId}:${agentId}`;

export const startNavigationTiming = (key: string, details: NavigationTimingDetails): void => {
  if (!isPerfLoggingEnabled()) {
    return;
  }

  pendingNavigations.set(key, {
    ...details,
    startedAt: getNowMs(),
  });

  perfLog(NAVIGATION_TAG, {
    phase: "start",
    key,
    from: details.from,
    to: details.to,
    targetMs: details.targetMs ?? null,
    params: details.params ?? null,
  });
};

export const endNavigationTiming = (key: string, extra?: Record<string, unknown>): void => {
  if (!isPerfLoggingEnabled()) {
    return;
  }

  const entry = pendingNavigations.get(key);
  if (!entry) {
    return;
  }
  pendingNavigations.delete(key);

  const durationMs = getNowMs() - entry.startedAt;
  perfLog(NAVIGATION_TAG, {
    phase: "complete",
    key,
    from: entry.from,
    to: entry.to,
    durationMs: Number(durationMs.toFixed(2)),
    targetMs: entry.targetMs ?? null,
    params: entry.params ?? null,
    extra: extra ?? null,
  });
};

export const cancelNavigationTiming = (key: string, reason?: string): void => {
  if (!isPerfLoggingEnabled()) {
    return;
  }

  if (!pendingNavigations.has(key)) {
    return;
  }
  pendingNavigations.delete(key);
  perfLog(NAVIGATION_TAG, {
    phase: "cancelled",
    key,
    reason: reason ?? null,
  });
};
