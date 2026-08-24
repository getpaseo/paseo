import { describe, expect, it } from "vitest";
import {
  __private__,
  deriveBottomAnchorBlockedReason,
  type BottomAnchorMode,
} from "./bottom-anchor-controller";
import type { BottomAnchorTransportBehavior } from "./strategy";

type MeasurementState = ReturnType<typeof createMeasurementState>;

function createMeasurementState(
  overrides?: Partial<{
    containerKey: string;
    viewportWidth: number;
    viewportHeight: number;
    contentHeight: number;
    offsetY: number;
    viewportMeasuredForKey: string | null;
    contentMeasuredForKey: string | null;
  }>,
) {
  return {
    containerKey: "scroll-view",
    viewportWidth: 0,
    viewportHeight: 0,
    contentHeight: 0,
    offsetY: 0,
    viewportMeasuredForKey: null,
    contentMeasuredForKey: null,
    ...overrides,
  };
}

function createPendingRequest() {
  return {
    id: 1,
    agentId: "agent-1",
    reason: "initial-entry" as const,
    requestKey: "route:agent-1",
  };
}

function createFrameScheduler() {
  let sequence = 0;
  const tasks = new Map<
    number,
    {
      cancelled: boolean;
      remainingFrames: number;
      callback: () => void;
      kind: "attempt" | "verification";
    }
  >();

  return {
    schedule(params: {
      kind: "attempt" | "verification";
      callback: () => void;
      delayFrames?: number;
    }) {
      const id = ++sequence;
      tasks.set(id, {
        cancelled: false,
        remainingFrames: Math.max(0, params.delayFrames ?? 0),
        callback: params.callback,
        kind: params.kind,
      });
      return id;
    },
    cancel(handle: unknown) {
      const task = tasks.get(handle as number);
      if (task) {
        task.cancelled = true;
      }
    },
    flushFrame() {
      const due: Array<() => void> = [];
      for (const [id, task] of Array.from(tasks.entries())) {
        if (task.cancelled) {
          tasks.delete(id);
          continue;
        }
        if (task.remainingFrames > 0) {
          task.remainingFrames -= 1;
          continue;
        }
        tasks.delete(id);
        due.push(task.callback);
      }
      for (const callback of due) {
        callback();
      }
    },
    flushAll(limit = 20) {
      for (let index = 0; index < limit && tasks.size > 0; index += 1) {
        this.flushFrame();
      }
    },
  };
}

function createDriverHarness(input?: {
  transportBehavior?: BottomAnchorTransportBehavior;
  isNearBottom?: boolean;
  measurementState?: MeasurementState;
  authoritativeReady?: boolean;
}) {
  const scheduler = createFrameScheduler();
  const measurementState =
    input?.measurementState ??
    createMeasurementState({
      viewportWidth: 800,
      viewportHeight: 480,
      contentHeight: 1200,
      viewportMeasuredForKey: "scroll-view",
      contentMeasuredForKey: "scroll-view",
    });
  const context = {
    agentId: "agent-1",
    authoritativeReady: input?.authoritativeReady ?? true,
    renderStrategy: "forward-stream",
    transportBehavior: input?.transportBehavior ?? {
      verificationDelayFrames: 0,
      verificationRetryMode: "rescroll",
    },
    measurementState,
    nearBottom: input?.isNearBottom ?? true,
  };
  const scrollAttempts: boolean[] = [];
  let scrollToBottomBehavior = () => {
    context.nearBottom = true;
    context.measurementState.offsetY = 720;
  };
  const scrollToBottom = (animated: boolean) => {
    scrollAttempts.push(animated);
    scrollToBottomBehavior();
  };
  const modeChanges: BottomAnchorMode[] = [];
  const driver = __private__.createBottomAnchorControllerDriver({
    getAgentId: () => context.agentId,
    getIsAuthoritativeHistoryReady: () => context.authoritativeReady,
    getRenderStrategy: () => context.renderStrategy,
    getTransportBehavior: () => context.transportBehavior,
    getMeasurementState: () => context.measurementState,
    isNearBottom: () => context.nearBottom,
    scrollToBottom,
    onModeChange: (mode) => {
      modeChanges.push(mode);
    },
    scheduleFrame: (params) => scheduler.schedule(params),
    cancelFrame: (handle) => scheduler.cancel(handle),
  });

  return {
    context,
    driver,
    scheduler,
    scrollAttempts,
    setScrollToBottomBehavior(next: () => void) {
      scrollToBottomBehavior = next;
    },
    modeChanges,
  };
}

describe("deriveBottomAnchorBlockedReason", () => {
  it("keeps initial-entry pending until history is ready and geometry is measurable", () => {
    const pendingRequest = createPendingRequest();

    expect(
      deriveBottomAnchorBlockedReason({
        pendingRequest,
        isAuthoritativeHistoryReady: false,
        measurementState: createMeasurementState(),
        pendingVerificationRequestId: null,
      }),
    ).toBe("waiting_for_history_readiness");

    expect(
      deriveBottomAnchorBlockedReason({
        pendingRequest,
        isAuthoritativeHistoryReady: true,
        measurementState: createMeasurementState({
          viewportHeight: 480,
          viewportMeasuredForKey: "scroll-view",
        }),
        pendingVerificationRequestId: null,
      }),
    ).toBe("waiting_for_measurable_content");

    expect(
      deriveBottomAnchorBlockedReason({
        pendingRequest,
        isAuthoritativeHistoryReady: true,
        measurementState: createMeasurementState({
          viewportHeight: 480,
          contentHeight: 1200,
          viewportMeasuredForKey: "scroll-view",
          contentMeasuredForKey: "scroll-view",
        }),
        pendingVerificationRequestId: pendingRequest.id,
      }),
    ).toBe("waiting_for_post_layout_verification");
  });
});

describe("bottom anchor controller driver", () => {
  it("keeps initial-entry pending until authoritative history and current geometry exist", () => {
    const harness = createDriverHarness({
      authoritativeReady: false,
      measurementState: createMeasurementState(),
    });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "initial-entry",
      requestKey: "route:agent-1:initial-entry",
    });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(0);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      blockedReason: "waiting_for_history_readiness",
      pendingRequest: {
        reason: "initial-entry",
      },
    });

    harness.context.authoritativeReady = true;
    harness.context.measurementState.viewportHeight = 480;
    harness.context.measurementState.contentHeight = 1200;
    harness.context.measurementState.viewportMeasuredForKey = "scroll-view";
    harness.context.measurementState.contentMeasuredForKey = "scroll-view";
    harness.context.nearBottom = true;
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.driver.reevaluate();
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot()).toMatchObject({
      blockedReason: null,
      pendingRequest: null,
      pendingVerification: null,
    });
  });

  it("preserves a blocked route anchor while a user scroll ends at the bottom", () => {
    const harness = createDriverHarness({ authoritativeReady: false });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "initial-entry",
      requestKey: "route:agent-1:initial-entry",
    });
    harness.scheduler.flushAll();

    harness.driver.beginUserScroll();
    harness.context.authoritativeReady = true;
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.driver.reevaluate();
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(0);

    harness.driver.endUserScroll({ isNearBottom: true });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      blockedReason: null,
      pendingRequest: null,
      pendingVerification: null,
    });
  });

  it("preserves a blocked route anchor when layout moves after drag release", () => {
    const harness = createDriverHarness({ authoritativeReady: false });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "resume",
      requestKey: "route:agent-1:resume",
    });
    harness.scheduler.flushAll();

    harness.driver.beginUserScroll();
    harness.context.nearBottom = false;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 0,
    });
    harness.context.authoritativeReady = true;
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.driver.endUserScroll({ isNearBottom: true });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      blockedReason: null,
      pendingRequest: null,
      pendingVerification: null,
    });
  });

  it("lets a user scroll away supersede a blocked route anchor", () => {
    const harness = createDriverHarness({ authoritativeReady: false });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "resume",
      requestKey: "route:agent-1:resume",
    });
    harness.scheduler.flushAll();

    harness.driver.beginUserScroll();
    harness.context.nearBottom = false;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 48,
    });
    harness.driver.endUserScroll({ isNearBottom: false });
    harness.context.authoritativeReady = true;
    harness.driver.notifyAuthoritativeHistoryMaybeChanged();
    harness.driver.reevaluate();
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(0);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "detached",
      blockedReason: null,
      pendingRequest: null,
      pendingVerification: null,
    });
  });

  it("suppresses sticky maintenance while detached", () => {
    const harness = createDriverHarness();

    harness.driver.detachByUser();
    harness.driver.handleContentSizeChange({
      previousContentHeight: 1200,
      contentHeight: 1500,
    });
    harness.driver.handleViewportMetricsChange({
      previousViewportWidth: 800,
      viewportWidth: 640,
      previousViewportHeight: 480,
      viewportHeight: 420,
    });
    harness.scheduler.flushAll();

    expect(harness.driver.getSnapshot().mode).toBe("detached");
    expect(harness.scrollAttempts).toHaveLength(0);
  });

  it("pauses sticky maintenance while a user scroll owns the viewport", () => {
    const harness = createDriverHarness({
      transportBehavior: {
        verificationDelayFrames: 2,
        verificationRetryMode: "recheck",
      },
    });

    harness.driver.prepareForStickyContentChange();
    harness.driver.beginUserScroll();
    harness.driver.handleContentSizeChange({
      previousContentHeight: 1200,
      contentHeight: 1400,
    });
    harness.context.nearBottom = false;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 1,
    });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      pendingRequest: null,
      pendingVerification: null,
    });

    harness.driver.endUserScroll({ isNearBottom: false });

    expect(harness.driver.getSnapshot().mode).toBe("detached");
  });

  it("restores sticky maintenance when a user scroll returns to the bottom", () => {
    const harness = createDriverHarness({
      transportBehavior: {
        verificationDelayFrames: 2,
        verificationRetryMode: "recheck",
      },
    });

    harness.driver.beginUserScroll();
    harness.context.nearBottom = false;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 48,
    });
    harness.driver.handleContentSizeChange({
      previousContentHeight: 1200,
      contentHeight: 1400,
    });
    harness.context.nearBottom = true;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: true,
      scrollDelta: -48,
    });
    harness.driver.endUserScroll({ isNearBottom: true });
    harness.scheduler.flushAll();

    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      pendingRequest: null,
      pendingVerification: null,
    });
    expect(harness.scrollAttempts).toHaveLength(1);
  });

  it("switches back to sticky-bottom for explicit jump-to-bottom", () => {
    const harness = createDriverHarness({
      isNearBottom: false,
    });

    harness.driver.detachByUser();
    harness.driver.requestLocalAnchor({
      agentId: "agent-1",
      reason: "jump-to-bottom",
    });
    harness.scheduler.flushAll();

    expect(harness.modeChanges).toContain("detached");
    expect(harness.modeChanges).toContain("sticky-bottom");
    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");
  });

  it("schedules sticky maintenance on viewport and content growth", () => {
    const harness = createDriverHarness();

    harness.driver.handleViewportMetricsChange({
      previousViewportWidth: 800,
      viewportWidth: 640,
      previousViewportHeight: 480,
      viewportHeight: 420,
    });
    harness.scheduler.flushAll();

    harness.driver.handleContentSizeChange({
      previousContentHeight: 1200,
      contentHeight: 1600,
    });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(2);
  });

  it("keeps a pending request blocked when stale container measurements arrive", () => {
    const harness = createDriverHarness({
      measurementState: createMeasurementState({
        containerKey: "web-partial-virtualized",
        viewportHeight: 420,
        contentHeight: 1200,
        viewportMeasuredForKey: "scroll-view",
        contentMeasuredForKey: "scroll-view",
      }),
    });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "resume",
      requestKey: "route:agent-1:resume",
    });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(0);
    expect(harness.driver.getSnapshot()).toMatchObject({
      blockedReason: "waiting_for_measurable_viewport",
      pendingRequest: {
        reason: "resume",
      },
    });

    harness.context.measurementState.viewportMeasuredForKey = "web-partial-virtualized";
    harness.context.measurementState.contentMeasuredForKey = "web-partial-virtualized";
    harness.driver.reevaluate();
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot().pendingRequest).toBeNull();
  });

  it("uses delayed rechecks instead of repeated rescroll loops for native transport", () => {
    const harness = createDriverHarness({
      transportBehavior: {
        verificationDelayFrames: 2,
        verificationRetryMode: "recheck",
      },
      isNearBottom: false,
    });
    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = 0;
    });

    harness.driver.requestLocalAnchor({
      agentId: "agent-1",
      reason: "jump-to-bottom",
    });

    harness.scheduler.flushFrame();
    expect(harness.scrollAttempts).toHaveLength(1);

    harness.scheduler.flushFrame();
    harness.scheduler.flushFrame();
    expect(harness.scrollAttempts).toHaveLength(1);

    harness.context.nearBottom = true;
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot().pendingRequest).toBeNull();
  });

  it("does not stay blocked on post-layout verification after a retry-scroll request", () => {
    const harness = createDriverHarness({
      measurementState: createMeasurementState({
        containerKey: "web-partial-virtualized",
        viewportWidth: 828,
        viewportHeight: 846,
        contentHeight: 14322,
        offsetY: 0,
        viewportMeasuredForKey: "web-partial-virtualized",
        contentMeasuredForKey: "web-partial-virtualized",
      }),
      isNearBottom: false,
    });

    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = 13476;
    });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "resume",
      requestKey: "route:agent-1:resume",
    });

    harness.scheduler.flushFrame();
    expect(harness.scrollAttempts).toHaveLength(1);

    harness.context.measurementState.contentHeight = 14804;
    harness.context.nearBottom = false;
    harness.driver.handleContentSizeChange({
      previousContentHeight: 14322,
      contentHeight: 14804,
    });

    harness.scheduler.flushFrame();

    expect(harness.driver.getSnapshot()).toMatchObject({
      pendingRequest: {
        reason: "resume",
      },
      pendingVerification: {
        requestId: 1,
        retries: 1,
      },
    });

    harness.scheduler.flushFrame();

    expect(harness.scrollAttempts).toHaveLength(2);
    expect(harness.driver.getSnapshot()).toMatchObject({
      blockedReason: "waiting_for_post_layout_verification",
      pendingRequest: {
        reason: "resume",
      },
      pendingVerification: {
        requestId: 1,
      },
    });
  });

  it("does not fulfill a web partial-virtualized resume request before a confirmation pass", () => {
    const harness = createDriverHarness({
      measurementState: createMeasurementState({
        containerKey: "web-partial-virtualized",
        viewportWidth: 828,
        viewportHeight: 846,
        contentHeight: 14322,
        offsetY: 0,
        viewportMeasuredForKey: "web-partial-virtualized",
        contentMeasuredForKey: "web-partial-virtualized",
      }),
      isNearBottom: false,
    });

    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = Math.max(
        0,
        harness.context.measurementState.contentHeight -
          harness.context.measurementState.viewportHeight,
      );
      harness.context.nearBottom = true;
    });

    harness.driver.applyRouteRequest({
      agentId: "agent-1",
      reason: "resume",
      requestKey: "route:agent-1:resume-confirmation",
    });

    harness.scheduler.flushFrame();
    harness.scheduler.flushFrame();

    expect(harness.driver.getSnapshot()).toMatchObject({
      pendingRequest: {
        reason: "resume",
      },
      blockedReason: "waiting_for_post_layout_verification",
    });

    harness.context.measurementState.contentHeight = 16230;
    harness.context.nearBottom = false;
    harness.driver.handleContentSizeChange({
      previousContentHeight: 14322,
      contentHeight: 16230,
    });

    harness.scheduler.flushFrame();
    harness.scheduler.flushFrame();
    harness.scheduler.flushFrame();

    expect(harness.scrollAttempts).toHaveLength(2);
    expect(harness.driver.getSnapshot().pendingRequest).toMatchObject({
      reason: "resume",
    });
  });

  it("keeps sticky-bottom during viewport growth until bottom is re-verified", () => {
    const harness = createDriverHarness();
    harness.context.nearBottom = false;
    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = 720;
    });

    harness.driver.handleViewportMetricsChange({
      previousViewportWidth: 800,
      viewportWidth: 800,
      previousViewportHeight: 480,
      viewportHeight: 420,
    });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(4);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      pendingRequest: null,
      pendingVerification: null,
    });

    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 0,
    });

    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");

    harness.context.nearBottom = true;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: true,
      scrollDelta: 0,
    });
    harness.scheduler.flushAll();
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 64,
    });

    expect(harness.driver.getSnapshot().mode).toBe("detached");
  });

  it("keeps sticky-bottom during streaming growth until bottom is re-verified", () => {
    const harness = createDriverHarness();
    harness.context.nearBottom = false;
    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = 900;
    });

    harness.driver.handleContentSizeChange({
      previousContentHeight: 1200,
      contentHeight: 1400,
    });
    harness.scheduler.flushAll();

    expect(harness.scrollAttempts).toHaveLength(4);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      pendingRequest: null,
      pendingVerification: null,
    });

    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 0,
    });

    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");

    harness.context.nearBottom = true;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: true,
      scrollDelta: 0,
    });
    harness.scheduler.flushAll();
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 64,
    });

    expect(harness.driver.getSnapshot().mode).toBe("detached");
  });

  it("keeps initial native content growth anchored before layout scroll events arrive", () => {
    const harness = createDriverHarness({
      transportBehavior: {
        verificationDelayFrames: 2,
        verificationRetryMode: "recheck",
      },
      measurementState: createMeasurementState({
        containerKey: "native-virtualized",
        viewportWidth: 0,
        viewportHeight: 0,
        contentHeight: 0,
        offsetY: 0,
        viewportMeasuredForKey: null,
        contentMeasuredForKey: null,
      }),
    });
    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = 0;
    });

    harness.context.measurementState.contentHeight = 1348;
    harness.context.measurementState.contentMeasuredForKey = "native-virtualized";
    harness.driver.handleContentSizeChange({
      previousContentHeight: 0,
      contentHeight: 1348,
    });

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      pendingVerification: {
        requestId: null,
      },
    });

    harness.context.measurementState.viewportWidth = 390;
    harness.context.measurementState.viewportHeight = 546;
    harness.context.measurementState.viewportMeasuredForKey = "native-virtualized";
    harness.context.measurementState.offsetY = 50;
    harness.context.nearBottom = false;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 50,
    });

    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");
  });

  it("keeps native sticky content changes anchored when measured height is unchanged", () => {
    const harness = createDriverHarness({
      transportBehavior: {
        verificationDelayFrames: 2,
        verificationRetryMode: "recheck",
      },
      measurementState: createMeasurementState({
        containerKey: "native-virtualized",
        viewportWidth: 390,
        viewportHeight: 546,
        contentHeight: 546,
        offsetY: 0,
        viewportMeasuredForKey: "native-virtualized",
        contentMeasuredForKey: "native-virtualized",
      }),
    });
    harness.setScrollToBottomBehavior(() => {
      harness.context.measurementState.offsetY = 0;
      harness.context.nearBottom = true;
    });

    harness.driver.prepareForStickyContentChange();

    expect(harness.scrollAttempts).toHaveLength(1);
    expect(harness.driver.getSnapshot()).toMatchObject({
      mode: "sticky-bottom",
      pendingVerification: {
        requestId: null,
      },
    });

    harness.context.measurementState.offsetY = 50;
    harness.context.nearBottom = false;
    harness.driver.handleScrollNearBottomChange({
      nextIsNearBottom: false,
      scrollDelta: 50,
    });

    expect(harness.driver.getSnapshot().mode).toBe("sticky-bottom");
  });
});

describe("controller helper predicates", () => {
  it("rejects stale container measurements during post-scroll verification", () => {
    expect(
      __private__.deriveVerificationBlockedReason({
        isAuthoritativeHistoryReady: true,
        measurementState: createMeasurementState({
          containerKey: "web-partial-virtualized",
          viewportHeight: 420,
          contentHeight: 1200,
          viewportMeasuredForKey: "scroll-view",
          contentMeasuredForKey: "scroll-view",
        }),
      }),
    ).toBe("waiting_for_measurable_viewport");
  });

  it("allows verification only after authoritative readiness and current geometry exist", () => {
    expect(
      __private__.deriveVerificationBlockedReason({
        isAuthoritativeHistoryReady: false,
        measurementState: createMeasurementState({
          containerKey: "scroll-view",
          viewportHeight: 420,
          contentHeight: 1200,
          viewportMeasuredForKey: "scroll-view",
          contentMeasuredForKey: "scroll-view",
        }),
      }),
    ).toBe("waiting_for_history_readiness");

    expect(
      __private__.deriveVerificationBlockedReason({
        isAuthoritativeHistoryReady: true,
        measurementState: createMeasurementState({
          containerKey: "scroll-view",
          viewportHeight: 420,
          contentHeight: 1200,
          viewportMeasuredForKey: "scroll-view",
          contentMeasuredForKey: "scroll-view",
        }),
      }),
    ).toBeNull();
  });

  it("suppresses auto-anchor helpers while detached", () => {
    const mode: BottomAnchorMode = "detached";

    expect(
      __private__.shouldRestickOnContentChange({
        mode,
        previousContentHeight: 1000,
        contentHeight: 1100,
      }),
    ).toBe(false);
    expect(
      __private__.shouldRestickOnViewportChange({
        mode,
        previousViewportWidth: 800,
        viewportWidth: 640,
        previousViewportHeight: 400,
        viewportHeight: 360,
      }),
    ).toBe(false);
  });

  it("does not detach from sticky while a restick request is still pending", () => {
    expect(
      __private__.shouldDetachFromScrollAway({
        mode: "sticky-bottom",
        nextIsNearBottom: false,
        scrollDelta: 0,
        hasPendingRequest: true,
        hasPendingVerification: false,
        hasUnverifiedStickyMeasurementChange: false,
      }),
    ).toBe(false);

    expect(
      __private__.shouldDetachFromScrollAway({
        mode: "sticky-bottom",
        nextIsNearBottom: false,
        scrollDelta: 0,
        hasPendingRequest: false,
        hasPendingVerification: true,
        hasUnverifiedStickyMeasurementChange: false,
      }),
    ).toBe(false);

    expect(
      __private__.shouldDetachFromScrollAway({
        mode: "sticky-bottom",
        nextIsNearBottom: false,
        scrollDelta: 0,
        hasPendingRequest: false,
        hasPendingVerification: false,
        hasUnverifiedStickyMeasurementChange: true,
      }),
    ).toBe(false);

    expect(
      __private__.shouldDetachFromScrollAway({
        mode: "sticky-bottom",
        nextIsNearBottom: false,
        scrollDelta: 0,
        hasPendingRequest: false,
        hasPendingVerification: false,
        hasUnverifiedStickyMeasurementChange: false,
      }),
    ).toBe(true);
  });

  it("treats a large scroll delta as user detach even during an unverified sticky change", () => {
    expect(
      __private__.shouldDetachFromScrollAway({
        mode: "sticky-bottom",
        nextIsNearBottom: false,
        scrollDelta: 48,
        hasPendingRequest: false,
        hasPendingVerification: false,
        hasUnverifiedStickyMeasurementChange: true,
      }),
    ).toBe(true);
  });
});
