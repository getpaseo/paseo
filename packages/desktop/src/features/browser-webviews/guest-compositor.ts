import {
  sendQueuedCdpCommand,
  type CdpDebuggable,
} from "../browser-automation/cdp-session-queue.js";
import type { BrowserGuestRegistration } from "./registry.js";

export const RUNAWAY_GUEST_WORKING_SET_KiB = 1024 * 1024;
export const RUNAWAY_GUEST_CHECKS_TO_RELOAD = 2;
export const RUNAWAY_GUEST_RELOAD_COOLDOWN_MS = 30_000;
export const RUNAWAY_GUEST_MAX_RELOADS = 3;
export const GUEST_COMPOSITOR_WATCHDOG_INTERVAL_MS = 5_000;

export type GuestCompositorBudget = "live" | "parked";
export type GuestLifecycleState = "active" | "frozen";
export type RunawayGuestAction = "none" | "reload" | "crash";

export interface GuestCompositorTarget {
  readonly id: number;
  isDestroyed(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
  reload(): void;
  forcefullyCrashRenderer(): void;
  getOSProcessId(): number;
}

export interface GuestProcessMetric {
  pid: number;
  type: string;
  memory: { workingSetSize: number };
}

interface GuestCompositorBudgetInput {
  isPresentedInHostWindow: boolean;
  isActiveInHostWindow: boolean;
  liveHoldCount: number;
}

interface RunawayGuestActionInput {
  workingSetKiB: number;
  consecutiveOverBudgetChecks: number;
  msSinceLastReload: number;
  reloadsThisGeneration: number;
}

interface RunawayGuestGenerationState {
  consecutiveOverBudgetChecks: number;
  lastReloadAt: number;
  reloadsThisGeneration: number;
}

interface AppliedGuestBudget {
  throttlingAllowed: boolean;
  lifecycle: GuestLifecycleState;
}

export interface GuestCompositorApplyInput {
  guests: BrowserGuestRegistration[];
  getContents(webContentsId: number): GuestCompositorTarget | null;
}

export interface GuestCompositorRunawayInput extends GuestCompositorApplyInput {
  metrics: GuestProcessMetric[];
}

export function guestCompositorBudget(input: GuestCompositorBudgetInput): GuestCompositorBudget {
  const hasLiveHold = input.liveHoldCount > 0;
  const isOnScreen = input.isPresentedInHostWindow || input.isActiveInHostWindow;
  if (isOnScreen || hasLiveHold) {
    return "live";
  }
  return "parked";
}

export function backgroundThrottlingAllowed(budget: GuestCompositorBudget): boolean {
  return budget === "parked";
}

export function guestLifecycleState(budget: GuestCompositorBudget): GuestLifecycleState {
  return budget === "parked" ? "frozen" : "active";
}

export function runawayGuestAction(input: RunawayGuestActionInput): RunawayGuestAction {
  if (input.workingSetKiB <= RUNAWAY_GUEST_WORKING_SET_KiB) {
    return "none";
  }
  if (input.consecutiveOverBudgetChecks < RUNAWAY_GUEST_CHECKS_TO_RELOAD) {
    return "none";
  }
  if (input.msSinceLastReload < RUNAWAY_GUEST_RELOAD_COOLDOWN_MS) {
    return "none";
  }
  if (input.reloadsThisGeneration >= RUNAWAY_GUEST_MAX_RELOADS) {
    return "crash";
  }
  return "reload";
}

interface CreateGuestCompositorOptions {
  setLifecycleState?: (
    contents: GuestCompositorTarget,
    state: GuestLifecycleState,
  ) => Promise<void>;
  now?: () => number;
  logWarn?: (message: string, extra?: Record<string, unknown>) => void;
}

export interface GuestCompositor {
  setPresented(input: { hostWebContentsId: number; browserId: string; presented: boolean }): void;
  setActive(input: { hostWebContentsId: number; browserId: string | null }): void;
  withLiveHold<T>(webContentsId: number, task: () => Promise<T>): Promise<T>;
  applyBudgets(input: GuestCompositorApplyInput): Promise<void>;
  handleRunawayGuests(input: GuestCompositorRunawayInput): void;
  releaseWebContents(webContentsId: number): void;
  releaseHost(hostWebContentsId: number): void;
}

function groupGuestsByPid(input: GuestCompositorApplyInput): Map<number, GuestCompositorTarget[]> {
  const guestsByPid = new Map<number, GuestCompositorTarget[]>();
  for (const guest of input.guests) {
    const contents = input.getContents(guest.webContentsId);
    if (!contents || contents.isDestroyed()) {
      continue;
    }
    const pid = contents.getOSProcessId();
    if (pid === 0) {
      continue;
    }
    const guests = guestsByPid.get(pid) ?? [];
    guests.push(contents);
    guestsByPid.set(pid, guests);
  }
  return guestsByPid;
}

function pruneMissingRunawayPids(
  runawayStateByPid: Map<number, RunawayGuestGenerationState>,
  guestsByPid: Map<number, GuestCompositorTarget[]>,
): void {
  const livePids = new Set(guestsByPid.keys());
  for (const pid of runawayStateByPid.keys()) {
    if (!livePids.has(pid)) {
      runawayStateByPid.delete(pid);
    }
  }
}

function applyRunawayMetric(input: {
  metric: GuestProcessMetric;
  guests: GuestCompositorTarget[];
  currentTime: number;
  runawayStateByPid: Map<number, RunawayGuestGenerationState>;
  logWarn?: (message: string, extra?: Record<string, unknown>) => void;
}): void {
  if (input.guests.length === 0) {
    return;
  }
  const previous = input.runawayStateByPid.get(input.metric.pid) ?? {
    consecutiveOverBudgetChecks: 0,
    lastReloadAt: 0,
    reloadsThisGeneration: 0,
  };
  if (input.metric.memory.workingSetSize <= RUNAWAY_GUEST_WORKING_SET_KiB) {
    input.runawayStateByPid.set(input.metric.pid, {
      consecutiveOverBudgetChecks: 0,
      lastReloadAt: previous.lastReloadAt,
      reloadsThisGeneration: 0,
    });
    return;
  }
  const consecutiveOverBudgetChecks = previous.consecutiveOverBudgetChecks + 1;
  const action = runawayGuestAction({
    workingSetKiB: input.metric.memory.workingSetSize,
    consecutiveOverBudgetChecks,
    msSinceLastReload: input.currentTime - previous.lastReloadAt,
    reloadsThisGeneration: previous.reloadsThisGeneration,
  });
  if (action === "none") {
    input.runawayStateByPid.set(input.metric.pid, {
      ...previous,
      consecutiveOverBudgetChecks,
    });
    return;
  }
  if (action === "reload") {
    input.logWarn?.("[guest-compositor] reloading runaway browser renderer", {
      pid: input.metric.pid,
      workingSetKiB: input.metric.memory.workingSetSize,
      attempt: previous.reloadsThisGeneration + 1,
    });
    for (const contents of input.guests) {
      if (!contents.isDestroyed()) {
        contents.reload();
      }
    }
    input.runawayStateByPid.set(input.metric.pid, {
      consecutiveOverBudgetChecks: 0,
      lastReloadAt: input.currentTime,
      reloadsThisGeneration: previous.reloadsThisGeneration + 1,
    });
    return;
  }
  input.logWarn?.("[guest-compositor] crashing runaway browser renderer", {
    pid: input.metric.pid,
    workingSetKiB: input.metric.memory.workingSetSize,
  });
  for (const contents of input.guests) {
    if (!contents.isDestroyed()) {
      contents.forcefullyCrashRenderer();
    }
  }
  input.runawayStateByPid.delete(input.metric.pid);
}

export function createGuestCompositor(options: CreateGuestCompositorOptions = {}): GuestCompositor {
  const liveHoldCountByWebContentsId = new Map<number, number>();
  const presentedBrowserIdsByHost = new Map<number, Set<string>>();
  const activeBrowserIdByHost = new Map<number, string>();
  const appliedBudgetByWebContentsId = new Map<number, AppliedGuestBudget>();
  const runawayStateByPid = new Map<number, RunawayGuestGenerationState>();
  const setLifecycleState = options.setLifecycleState;
  const now = options.now ?? Date.now;
  const logWarn = options.logWarn;
  let applyChain: Promise<void> = Promise.resolve();

  function liveHoldCount(webContentsId: number): number {
    return liveHoldCountByWebContentsId.get(webContentsId) ?? 0;
  }

  function isPresented(hostWebContentsId: number, browserId: string): boolean {
    return presentedBrowserIdsByHost.get(hostWebContentsId)?.has(browserId) === true;
  }

  function isActive(hostWebContentsId: number, browserId: string): boolean {
    return activeBrowserIdByHost.get(hostWebContentsId) === browserId;
  }

  function beginLiveHold(webContentsId: number): void {
    liveHoldCountByWebContentsId.set(webContentsId, liveHoldCount(webContentsId) + 1);
  }

  function endLiveHold(webContentsId: number): void {
    const nextCount = liveHoldCount(webContentsId) - 1;
    if (nextCount <= 0) {
      liveHoldCountByWebContentsId.delete(webContentsId);
      return;
    }
    liveHoldCountByWebContentsId.set(webContentsId, nextCount);
  }

  function budgetForGuest(
    guest: BrowserGuestRegistration,
    contents: GuestCompositorTarget,
  ): GuestCompositorBudget {
    return guestCompositorBudget({
      isPresentedInHostWindow: isPresented(guest.hostWebContentsId, guest.browserId),
      isActiveInHostWindow: isActive(guest.hostWebContentsId, guest.browserId),
      liveHoldCount: liveHoldCount(contents.id),
    });
  }

  async function applyBudgetToGuest(
    guest: BrowserGuestRegistration,
    contents: GuestCompositorTarget,
  ): Promise<void> {
    for (;;) {
      if (contents.isDestroyed()) {
        appliedBudgetByWebContentsId.delete(contents.id);
        return;
      }
      const budget = budgetForGuest(guest, contents);
      const throttlingAllowed = backgroundThrottlingAllowed(budget);
      const lifecycle = guestLifecycleState(budget);
      const applied = appliedBudgetByWebContentsId.get(contents.id);
      if (applied?.throttlingAllowed !== throttlingAllowed) {
        contents.setBackgroundThrottling(throttlingAllowed);
      }
      const lifecycleChanged = applied?.lifecycle !== lifecycle;
      if (lifecycleChanged && setLifecycleState) {
        try {
          await setLifecycleState(contents, lifecycle);
        } catch (error) {
          logWarn?.("[guest-compositor] failed to set page lifecycle", {
            webContentsId: contents.id,
            lifecycle,
            error: error instanceof Error ? error.message : String(error),
          });
          appliedBudgetByWebContentsId.set(contents.id, {
            throttlingAllowed,
            lifecycle: applied?.lifecycle ?? "active",
          });
          return;
        }
        appliedBudgetByWebContentsId.set(contents.id, { throttlingAllowed, lifecycle });
        continue;
      }
      appliedBudgetByWebContentsId.set(contents.id, { throttlingAllowed, lifecycle });
      return;
    }
  }

  return {
    setPresented(input) {
      const presentedBrowserIds =
        presentedBrowserIdsByHost.get(input.hostWebContentsId) ?? new Set<string>();
      if (input.presented) {
        presentedBrowserIds.add(input.browserId);
        presentedBrowserIdsByHost.set(input.hostWebContentsId, presentedBrowserIds);
        return;
      }
      presentedBrowserIds.delete(input.browserId);
      if (presentedBrowserIds.size === 0) {
        presentedBrowserIdsByHost.delete(input.hostWebContentsId);
        return;
      }
      presentedBrowserIdsByHost.set(input.hostWebContentsId, presentedBrowserIds);
    },

    setActive(input) {
      if (input.browserId === null) {
        activeBrowserIdByHost.delete(input.hostWebContentsId);
        return;
      }
      activeBrowserIdByHost.set(input.hostWebContentsId, input.browserId);
    },

    async withLiveHold<T>(webContentsId: number, task: () => Promise<T>): Promise<T> {
      beginLiveHold(webContentsId);
      try {
        return await task();
      } finally {
        endLiveHold(webContentsId);
      }
    },

    async applyBudgets(input) {
      const previous = applyChain;
      let releaseCurrent = () => {};
      const current = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      applyChain = previous.catch(() => {}).then(() => current);
      await previous.catch(() => {});
      try {
        for (const guest of input.guests) {
          const contents = input.getContents(guest.webContentsId);
          if (!contents) {
            appliedBudgetByWebContentsId.delete(guest.webContentsId);
            continue;
          }
          await applyBudgetToGuest(guest, contents);
        }
      } finally {
        releaseCurrent();
      }
    },

    handleRunawayGuests(input) {
      const currentTime = now();
      const guestsByPid = groupGuestsByPid(input);
      pruneMissingRunawayPids(runawayStateByPid, guestsByPid);
      for (const metric of input.metrics) {
        applyRunawayMetric({
          metric,
          guests: guestsByPid.get(metric.pid) ?? [],
          currentTime,
          runawayStateByPid,
          logWarn,
        });
      }
    },

    releaseWebContents(webContentsId) {
      liveHoldCountByWebContentsId.delete(webContentsId);
      appliedBudgetByWebContentsId.delete(webContentsId);
    },

    releaseHost(hostWebContentsId) {
      presentedBrowserIdsByHost.delete(hostWebContentsId);
      activeBrowserIdByHost.delete(hostWebContentsId);
    },
  };
}

function isCdpDebuggable(
  contents: GuestCompositorTarget,
): contents is GuestCompositorTarget & CdpDebuggable {
  return "debugger" in contents;
}

export async function setGuestPageLifecycle(
  contents: GuestCompositorTarget,
  state: GuestLifecycleState,
): Promise<void> {
  if (!isCdpDebuggable(contents)) {
    return;
  }
  await sendQueuedCdpCommand(contents, "Page.setWebLifecycleState", { state });
}

export const guestCompositor = createGuestCompositor({
  setLifecycleState: setGuestPageLifecycle,
  logWarn: (message, extra) => {
    console.warn(message, extra ?? {});
  },
});

export function setupGuestCompositorWatchdog(input: {
  compositor?: GuestCompositor;
  listGuests: () => BrowserGuestRegistration[];
  getContents: (webContentsId: number) => GuestCompositorTarget | null;
  getMetrics: () => GuestProcessMetric[];
}): () => void {
  const compositor = input.compositor ?? guestCompositor;
  const tick = async () => {
    const guests = input.listGuests();
    try {
      await compositor.applyBudgets({
        guests,
        getContents: input.getContents,
      });
      compositor.handleRunawayGuests({
        guests,
        getContents: input.getContents,
        metrics: input.getMetrics(),
      });
    } catch (error) {
      console.warn("[guest-compositor] watchdog tick failed", error);
    }
  };
  const timer = setInterval(tick, GUEST_COMPOSITOR_WATCHDOG_INTERVAL_MS);
  return () => {
    clearInterval(timer);
  };
}
