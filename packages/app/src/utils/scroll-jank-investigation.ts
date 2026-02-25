import { Platform } from "react-native";

type ListenerStats = {
  adds: number;
  removes: number;
  active: number;
};

type TimerStats = {
  created: number;
  fired: number;
  cleared: number;
  active: number;
};

type WebSocketStats = {
  created: number;
  opened: number;
  closed: number;
  errored: number;
  active: number;
};

type ComponentStats = {
  mounts: number;
  unmounts: number;
  renders: number;
  scrollEvents: number;
  nearBottomTransitions: number;
  metricUpdates: number;
  itemRenderCalls: number;
  wheelAttach: number;
  wheelDetach: number;
  inputChanges: number;
  keyPresses: number;
  lastRenderAtMs: number;
};

type ScrollInvestigationStore = {
  markRender: (componentId: string) => void;
  markEvent: (
    componentId: string,
    event:
      | "mount"
      | "unmount"
      | "scrollEvent"
      | "nearBottomTransition"
      | "metricUpdate"
      | "itemRenderCall"
      | "wheelAttach"
      | "wheelDetach"
      | "inputChange"
      | "keyPress"
  ) => void;
  snapshot: () => {
    listeners: {
      byType: Record<string, ListenerStats>;
      byCallsite: Record<string, number>;
      activeUniqueKeys: number;
      activeByTypeAndTarget: Record<string, Record<string, number>>;
    };
    timers: {
      timeout: TimerStats;
      interval: TimerStats;
      raf: TimerStats;
    };
    websockets: {
      totals: WebSocketStats;
      activeByUrl: Record<string, number>;
    };
    components: Record<string, ComponentStats>;
  };
  printSnapshot: (label?: string) => void;
  _installedAtMs: number;
};

type ScrollInvestigationGlobal = typeof globalThis & {
  __PASEO_SCROLL_JANK_INVESTIGATION__?: ScrollInvestigationStore;
  __PASEO_SCROLL_JANK_INVESTIGATION_DISABLED__?: boolean;
};

const TRACKED_EVENT_TYPES = new Set([
  "wheel",
  "scroll",
  "pointermove",
  "pointerup",
  "pointercancel",
]);

const SOURCE_LABEL = "[ScrollJankInvestigation]";

function shouldInstall(): boolean {
  const runtime = globalThis as ScrollInvestigationGlobal;
  const isDev = Boolean((globalThis as { __DEV__?: boolean }).__DEV__);
  return (
    Platform.OS === "web" &&
    isDev &&
    !runtime.__PASEO_SCROLL_JANK_INVESTIGATION_DISABLED__
  );
}

function normalizeCapture(options?: AddEventListenerOptions | boolean): boolean {
  if (typeof options === "boolean") {
    return options;
  }
  return Boolean(options?.capture);
}

function describeEventTarget(target: EventTarget): string {
  const element = target as Element;
  if (element && typeof element === "object" && "tagName" in element) {
    const tagName = (element.tagName || "unknown").toLowerCase();
    const testId = element.getAttribute?.("data-testid");
    const role = element.getAttribute?.("role");
    const id = (element as HTMLElement).id || null;
    const className = (element as HTMLElement).className;
    const classLabel =
      typeof className === "string" && className.trim().length > 0
        ? className.trim().split(/\s+/).slice(0, 2).join(".")
        : null;
    const connectivityLabel =
      typeof (element as Node).isConnected === "boolean"
        ? (element as Node).isConnected
          ? "[connected]"
          : "[detached]"
        : null;

    return [
      tagName,
      id ? `#${id}` : null,
      testId ? `[data-testid=${testId}]` : null,
      role ? `[role=${role}]` : null,
      classLabel ? `.${classLabel}` : null,
      connectivityLabel,
    ]
      .filter(Boolean)
      .join("");
  }

  const ctorName = (target as { constructor?: { name?: string } }).constructor
    ?.name;
  return ctorName || "unknown-target";
}

function inferCallsite(): string {
  const stack = new Error().stack;
  if (!stack) {
    return "unknown";
  }
  const frames = stack.split("\n");
  for (const raw of frames.slice(2)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (line.includes("scroll-jank-investigation")) {
      continue;
    }
    if (line.includes("patchedAddEventListener")) {
      continue;
    }
    return line;
  }
  return "unknown";
}

function ensureListenerStats(
  map: Map<string, ListenerStats>,
  type: string
): ListenerStats {
  const existing = map.get(type);
  if (existing) {
    return existing;
  }
  const next: ListenerStats = { adds: 0, removes: 0, active: 0 };
  map.set(type, next);
  return next;
}

function ensureComponentStats(
  map: Map<string, ComponentStats>,
  componentId: string
): ComponentStats {
  const existing = map.get(componentId);
  if (existing) {
    return existing;
  }
  const next: ComponentStats = {
    mounts: 0,
    unmounts: 0,
    renders: 0,
    scrollEvents: 0,
    nearBottomTransitions: 0,
    metricUpdates: 0,
    itemRenderCalls: 0,
    wheelAttach: 0,
    wheelDetach: 0,
    inputChanges: 0,
    keyPresses: 0,
    lastRenderAtMs: 0,
  };
  map.set(componentId, next);
  return next;
}

export function installScrollJankInvestigation(): void {
  if (!shouldInstall()) {
    return;
  }

  const runtime = globalThis as ScrollInvestigationGlobal;
  if (runtime.__PASEO_SCROLL_JANK_INVESTIGATION__) {
    return;
  }

  const targetIds = new WeakMap<object, number>();
  const listenerIds = new WeakMap<object, number>();
  const activeListenerKeys = new Set<string>();
  const activeListenerMeta = new Map<
    string,
    { type: string; target: string }
  >();
  const listenerStatsByType = new Map<string, ListenerStats>();
  const listenerCallsiteCount = new Map<string, number>();
  const componentStatsById = new Map<string, ComponentStats>();
  const activeWsByUrl = new Map<string, number>();
  const timeoutHandles = new Map<number, true>();
  const intervalHandles = new Map<number, true>();
  const rafHandles = new Map<number, true>();
  let nextTargetId = 1;
  let nextListenerId = 1;

  const timerStats = {
    timeout: { created: 0, fired: 0, cleared: 0, active: 0 } as TimerStats,
    interval: { created: 0, fired: 0, cleared: 0, active: 0 } as TimerStats,
    raf: { created: 0, fired: 0, cleared: 0, active: 0 } as TimerStats,
  };
  const websocketStats: WebSocketStats = {
    created: 0,
    opened: 0,
    closed: 0,
    errored: 0,
    active: 0,
  };

  const eventTargetProto = EventTarget.prototype as EventTarget & {
    addEventListener: EventTarget["addEventListener"];
    removeEventListener: EventTarget["removeEventListener"];
  };
  const nativeAddEventListener = eventTargetProto.addEventListener;
  const nativeRemoveEventListener = eventTargetProto.removeEventListener;

  function getTargetId(target: EventTarget): string {
    const targetObj = target as unknown as object;
    const existing = targetIds.get(targetObj);
    if (existing) {
      return String(existing);
    }
    const next = nextTargetId++;
    targetIds.set(targetObj, next);
    return String(next);
  }

  function getListenerId(listener: EventListenerOrEventListenerObject): string {
    const listenerObj = listener as unknown as object;
    const existing = listenerIds.get(listenerObj);
    if (existing) {
      return String(existing);
    }
    const next = nextListenerId++;
    listenerIds.set(listenerObj, next);
    return String(next);
  }

  function toListenerKey(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean
  ): string {
    return [
      getTargetId(target),
      type,
      normalizeCapture(options) ? "capture" : "bubble",
      getListenerId(listener),
    ].join("|");
  }

  eventTargetProto.addEventListener = function patchedAddEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    nativeAddEventListener.call(this, type, listener as any, options as any);
    if (!listener) {
      return;
    }
    const stats = ensureListenerStats(listenerStatsByType, type);
    stats.adds += 1;

    const key = toListenerKey(this, type, listener, options);
    if (!activeListenerKeys.has(key)) {
      activeListenerKeys.add(key);
      stats.active += 1;
      activeListenerMeta.set(key, {
        type,
        target: describeEventTarget(this),
      });
    }

    if (TRACKED_EVENT_TYPES.has(type)) {
      const callsite = inferCallsite();
      const metricKey = `${type} :: ${callsite}`;
      listenerCallsiteCount.set(
        metricKey,
        (listenerCallsiteCount.get(metricKey) ?? 0) + 1
      );
    }
  };

  eventTargetProto.removeEventListener = function patchedRemoveEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean
  ): void {
    nativeRemoveEventListener.call(this, type, listener as any, options as any);
    if (!listener) {
      return;
    }
    const stats = ensureListenerStats(listenerStatsByType, type);
    stats.removes += 1;

    const key = toListenerKey(this, type, listener, options);
    if (activeListenerKeys.delete(key)) {
      stats.active = Math.max(0, stats.active - 1);
      activeListenerMeta.delete(key);
    }
  };

  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const nativeSetInterval = globalThis.setInterval.bind(globalThis);
  const nativeClearInterval = globalThis.clearInterval.bind(globalThis);
  const nativeRequestAnimationFrame =
    globalThis.requestAnimationFrame.bind(globalThis);
  const nativeCancelAnimationFrame =
    globalThis.cancelAnimationFrame.bind(globalThis);

  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    timerStats.timeout.created += 1;
    let timeoutId = -1;
    const wrapped =
      typeof handler === "function"
        ? (...handlerArgs: unknown[]) => {
            if (timeoutHandles.delete(timeoutId)) {
              timerStats.timeout.fired += 1;
              timerStats.timeout.active = timeoutHandles.size;
            }
            return handler(...handlerArgs);
          }
        : handler;

    timeoutId = nativeSetTimeout(wrapped, timeout, ...(args as any[])) as unknown as number;
    timeoutHandles.set(timeoutId, true);
    timerStats.timeout.active = timeoutHandles.size;
    return timeoutId as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.clearTimeout = ((timeoutId?: number) => {
    if (typeof timeoutId === "number" && timeoutHandles.delete(timeoutId)) {
      timerStats.timeout.cleared += 1;
      timerStats.timeout.active = timeoutHandles.size;
    }
    return nativeClearTimeout(timeoutId);
  }) as typeof clearTimeout;

  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    timerStats.interval.created += 1;
    let intervalId = -1;
    const wrapped =
      typeof handler === "function"
        ? (...handlerArgs: unknown[]) => {
            timerStats.interval.fired += 1;
            return handler(...handlerArgs);
          }
        : handler;

    intervalId = nativeSetInterval(wrapped, timeout, ...(args as any[])) as unknown as number;
    intervalHandles.set(intervalId, true);
    timerStats.interval.active = intervalHandles.size;
    return intervalId as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  globalThis.clearInterval = ((intervalId?: number) => {
    if (typeof intervalId === "number" && intervalHandles.delete(intervalId)) {
      timerStats.interval.cleared += 1;
      timerStats.interval.active = intervalHandles.size;
    }
    return nativeClearInterval(intervalId);
  }) as typeof clearInterval;

  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    timerStats.raf.created += 1;
    let rafId = -1;
    const wrapped = (timestamp: number) => {
      if (rafHandles.delete(rafId)) {
        timerStats.raf.fired += 1;
        timerStats.raf.active = rafHandles.size;
      }
      callback(timestamp);
    };
    rafId = nativeRequestAnimationFrame(wrapped) as unknown as number;
    rafHandles.set(rafId, true);
    timerStats.raf.active = rafHandles.size;
    return rafId as unknown as ReturnType<typeof requestAnimationFrame>;
  }) as typeof requestAnimationFrame;

  globalThis.cancelAnimationFrame = ((rafId: number) => {
    if (rafHandles.delete(rafId)) {
      timerStats.raf.cleared += 1;
      timerStats.raf.active = rafHandles.size;
    }
    return nativeCancelAnimationFrame(rafId);
  }) as typeof cancelAnimationFrame;

  const NativeWebSocket = globalThis.WebSocket;
  if (typeof NativeWebSocket === "function") {
    class InstrumentedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) {
          super(url);
        } else {
          super(url, protocols);
        }
        const urlKey = String(url);
        websocketStats.created += 1;
        websocketStats.active += 1;
        activeWsByUrl.set(urlKey, (activeWsByUrl.get(urlKey) ?? 0) + 1);

        const handleOpen = () => {
          websocketStats.opened += 1;
        };
        const handleError = () => {
          websocketStats.errored += 1;
        };
        const handleClose = () => {
          websocketStats.closed += 1;
          websocketStats.active = Math.max(0, websocketStats.active - 1);
          const current = activeWsByUrl.get(urlKey) ?? 0;
          if (current <= 1) {
            activeWsByUrl.delete(urlKey);
          } else {
            activeWsByUrl.set(urlKey, current - 1);
          }
          this.removeEventListener("open", handleOpen);
          this.removeEventListener("error", handleError);
          this.removeEventListener("close", handleClose);
        };

        this.addEventListener("open", handleOpen);
        this.addEventListener("error", handleError);
        this.addEventListener("close", handleClose);
      }
    }
    globalThis.WebSocket = InstrumentedWebSocket as typeof WebSocket;
  }

  const store: ScrollInvestigationStore = {
    markRender(componentId: string) {
      const stats = ensureComponentStats(componentStatsById, componentId);
      stats.renders += 1;
      stats.lastRenderAtMs = performance.now();
    },
    markEvent(componentId: string, event) {
      const stats = ensureComponentStats(componentStatsById, componentId);
      switch (event) {
        case "mount":
          stats.mounts += 1;
          return;
        case "unmount":
          stats.unmounts += 1;
          return;
        case "scrollEvent":
          stats.scrollEvents += 1;
          return;
        case "nearBottomTransition":
          stats.nearBottomTransitions += 1;
          return;
        case "metricUpdate":
          stats.metricUpdates += 1;
          return;
        case "itemRenderCall":
          stats.itemRenderCalls += 1;
          return;
        case "wheelAttach":
          stats.wheelAttach += 1;
          return;
        case "wheelDetach":
          stats.wheelDetach += 1;
          return;
        case "inputChange":
          stats.inputChanges += 1;
          return;
        case "keyPress":
          stats.keyPresses += 1;
          return;
        default:
          return;
      }
    },
    snapshot() {
      const activeByTypeAndTarget: Record<string, Record<string, number>> = {};
      for (const { type, target } of activeListenerMeta.values()) {
        const existingByType = activeByTypeAndTarget[type] ?? {};
        existingByType[target] = (existingByType[target] ?? 0) + 1;
        activeByTypeAndTarget[type] = existingByType;
      }
      return {
        listeners: {
          byType: Object.fromEntries(listenerStatsByType.entries()),
          byCallsite: Object.fromEntries(listenerCallsiteCount.entries()),
          activeUniqueKeys: activeListenerKeys.size,
          activeByTypeAndTarget,
        },
        timers: {
          timeout: { ...timerStats.timeout, active: timeoutHandles.size },
          interval: { ...timerStats.interval, active: intervalHandles.size },
          raf: { ...timerStats.raf, active: rafHandles.size },
        },
        websockets: {
          totals: { ...websocketStats },
          activeByUrl: Object.fromEntries(activeWsByUrl.entries()),
        },
        components: Object.fromEntries(componentStatsById.entries()),
      };
    },
    printSnapshot(label?: string) {
      console.log(`${SOURCE_LABEL} ${label ?? "snapshot"}`, this.snapshot());
    },
    _installedAtMs: Date.now(),
  };

  runtime.__PASEO_SCROLL_JANK_INVESTIGATION__ = store;
  console.log(
    `${SOURCE_LABEL} installed`,
    "Use window.__PASEO_SCROLL_JANK_INVESTIGATION__.snapshot()"
  );
}

function getStore(): ScrollInvestigationStore | null {
  const runtime = globalThis as ScrollInvestigationGlobal;
  return runtime.__PASEO_SCROLL_JANK_INVESTIGATION__ ?? null;
}

export function markScrollInvestigationRender(componentId: string): void {
  if (!shouldInstall()) {
    return;
  }
  getStore()?.markRender(componentId);
}

export function markScrollInvestigationEvent(
  componentId: string,
  event:
    | "mount"
    | "unmount"
    | "scrollEvent"
    | "nearBottomTransition"
    | "metricUpdate"
    | "itemRenderCall"
    | "wheelAttach"
    | "wheelDetach"
    | "inputChange"
    | "keyPress"
): void {
  if (!shouldInstall()) {
    return;
  }
  getStore()?.markEvent(componentId, event);
}
