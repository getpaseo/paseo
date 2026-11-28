import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  createFollowOutputScrollController,
  createFollowOutputScrollState,
  MAX_PERSISTED_FOLLOW_OUTPUT_PANELS,
  reduceFollowOutputUserScroll,
  resetFollowOutputScrollPersistence,
  resolveFollowOutputContentSizeAction,
  shouldIgnoreFollowOutputScrollReset,
  shouldStickFollowOutputToBottom,
  type FollowOutputScrollMetrics,
  type FollowOutputScrollable,
} from "./follow-output-scroll";

function metrics(
  offsetY: number,
  contentHeight = 800,
  viewportHeight = 400,
): FollowOutputScrollMetrics {
  return { offsetY, contentHeight, viewportHeight };
}

function fakeScrollable(): FollowOutputScrollable & {
  scrollToEnd: Mock<FollowOutputScrollable["scrollToEnd"]>;
  scrollTo: Mock<FollowOutputScrollable["scrollTo"]>;
} {
  return {
    scrollToEnd: vi.fn<FollowOutputScrollable["scrollToEnd"]>(),
    scrollTo: vi.fn<FollowOutputScrollable["scrollTo"]>(),
  };
}

afterEach(() => {
  resetFollowOutputScrollPersistence();
});

describe("follow-output scroll", () => {
  it("sticks to new output while the reader stays at the bottom", () => {
    const state = createFollowOutputScrollState(400);
    expect(shouldStickFollowOutputToBottom({ enabled: true, following: state.following })).toBe(
      true,
    );
  });

  it("stops pushing the reader down after they scroll up through streaming output", () => {
    const state = reduceFollowOutputUserScroll(createFollowOutputScrollState(400), metrics(280));
    expect(state.following).toBe(false);
    expect(shouldStickFollowOutputToBottom({ enabled: true, following: state.following })).toBe(
      false,
    );
  });

  it("does not treat a 1px jitter as the reader leaving the bottom", () => {
    const state = reduceFollowOutputUserScroll(createFollowOutputScrollState(400), metrics(399));
    expect(state.following).toBe(true);
  });

  it("reattaches when the reader scrolls back to the bottom", () => {
    const detached = reduceFollowOutputUserScroll(createFollowOutputScrollState(400), metrics(200));
    const reattached = reduceFollowOutputUserScroll(detached, metrics(400));
    expect(reattached.following).toBe(true);
    expect(
      shouldStickFollowOutputToBottom({ enabled: true, following: reattached.following }),
    ).toBe(true);
  });

  it("does not reattach from a downward scroll that is still above the bottom", () => {
    const detached = reduceFollowOutputUserScroll(createFollowOutputScrollState(400), metrics(100));
    const stillDetached = reduceFollowOutputUserScroll(detached, metrics(200));
    expect(stillDetached.following).toBe(false);
  });

  it("does not pin a panel that never streamed", () => {
    expect(shouldStickFollowOutputToBottom({ enabled: false, following: true })).toBe(false);
    expect(
      resolveFollowOutputContentSizeAction({
        enabled: false,
        following: true,
        hasStreamed: false,
        restoreOffsetY: null,
      }),
    ).toBe("none");
  });

  it("keeps a glued finished panel pinned to the end", () => {
    expect(
      shouldStickFollowOutputToBottom({
        enabled: false,
        following: true,
        hasStreamed: true,
      }),
    ).toBe(true);
    expect(
      resolveFollowOutputContentSizeAction({
        enabled: false,
        following: true,
        hasStreamed: true,
        restoreOffsetY: null,
      }),
    ).toBe("stick-end");
  });

  it("keeps a scrolled-up finished panel at its last offset", () => {
    expect(
      shouldStickFollowOutputToBottom({
        enabled: false,
        following: false,
        hasStreamed: true,
      }),
    ).toBe(false);
    expect(
      resolveFollowOutputContentSizeAction({
        enabled: false,
        following: false,
        hasStreamed: true,
        restoreOffsetY: 280,
      }),
    ).toBe("restore");
  });

  it("ignores a layout reset to the start while the panel is still glued", () => {
    expect(
      shouldIgnoreFollowOutputScrollReset({
        following: true,
        offsetY: 0,
        lastOffsetY: 400,
        isLayoutReset: false,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreFollowOutputScrollReset({
        following: true,
        offsetY: 0,
        lastOffsetY: 0,
        isLayoutReset: false,
      }),
    ).toBe(true);
  });

  it("ignores a layout reset to the start right after the reader scrolled up", () => {
    expect(
      shouldIgnoreFollowOutputScrollReset({
        following: false,
        offsetY: 0,
        lastOffsetY: 280,
        isLayoutReset: true,
      }),
    ).toBe(true);
  });

  it("does not ignore a real scroll to the top", () => {
    expect(
      shouldIgnoreFollowOutputScrollReset({
        following: false,
        offsetY: 0,
        lastOffsetY: 0,
        isLayoutReset: true,
      }),
    ).toBe(false);
  });

  it("does not ignore a detached reader's real scroll to the top once the panel has settled", () => {
    expect(
      shouldIgnoreFollowOutputScrollReset({
        following: false,
        offsetY: 0,
        lastOffsetY: 280,
        isLayoutReset: false,
      }),
    ).toBe(false);
  });
});

describe("createFollowOutputScrollController", () => {
  it("keeps the latest streaming output in view until the reader scrolls up", () => {
    const scrollable = fakeScrollable();
    const controller = createFollowOutputScrollController(true);
    controller.attach(scrollable);
    controller.mount();

    controller.onScroll(metrics(400));
    controller.onContentSizeChange();
    expect(scrollable.scrollToEnd).toHaveBeenCalledWith({ animated: false });

    scrollable.scrollToEnd.mockClear();
    controller.onScroll(metrics(280));
    controller.onContentSizeChange();
    expect(scrollable.scrollToEnd).not.toHaveBeenCalled();

    controller.onScroll(metrics(400));
    controller.onContentSizeChange();
    expect(scrollable.scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it("keeps a glued panel at the end after streaming ends", () => {
    const scrollable = fakeScrollable();
    const controller = createFollowOutputScrollController(true);
    controller.attach(scrollable);
    controller.mount();

    controller.onScroll(metrics(400));
    scrollable.scrollToEnd.mockClear();
    scrollable.scrollTo.mockClear();

    controller.setEnabled(false);
    controller.mount();
    expect(scrollable.scrollTo).not.toHaveBeenCalled();
    expect(scrollable.scrollToEnd).toHaveBeenCalledWith({ animated: false });

    scrollable.scrollToEnd.mockClear();
    controller.onScroll(metrics(400));
    controller.onContentSizeChange();
    expect(scrollable.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(scrollable.scrollTo).not.toHaveBeenCalled();

    scrollable.scrollToEnd.mockClear();
    controller.onScroll(metrics(0));
    expect(scrollable.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(scrollable.scrollTo).not.toHaveBeenCalled();
  });

  it("does not jump a scrolled-up reader to the start when streaming ends", () => {
    const scrollable = fakeScrollable();
    const controller = createFollowOutputScrollController(true);
    controller.attach(scrollable);
    controller.mount();

    controller.onScroll(metrics(400));
    controller.onScroll(metrics(280));
    scrollable.scrollToEnd.mockClear();
    scrollable.scrollTo.mockClear();

    controller.setEnabled(false);
    controller.mount();
    expect(scrollable.scrollToEnd).not.toHaveBeenCalled();
    expect(scrollable.scrollTo).toHaveBeenCalledWith({ y: 280, animated: false });
  });

  it("pins a glued panel to the end after it remounts as history", () => {
    const first = fakeScrollable();
    const live = createFollowOutputScrollController(true, "thought-1");
    live.attach(first);
    live.mount();
    live.onScroll(metrics(400));
    live.unmount();

    const second = fakeScrollable();
    const history = createFollowOutputScrollController(false, "thought-1");
    history.attach(second);
    history.mount();
    expect(second.scrollTo).not.toHaveBeenCalled();
    expect(second.scrollToEnd).toHaveBeenCalledWith({ animated: false });

    second.scrollToEnd.mockClear();
    history.onScroll(metrics(400));
    history.onContentSizeChange();
    history.onScroll(metrics(0));
    expect(second.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(second.scrollTo).not.toHaveBeenCalled();
  });

  it("puts a glued panel back at the end after remount even if no scroll events fired", () => {
    const first = fakeScrollable();
    const live = createFollowOutputScrollController(true, "thought-2");
    live.attach(first);
    live.mount();
    live.onContentSizeChange();
    live.unmount();

    const second = fakeScrollable();
    const history = createFollowOutputScrollController(false, "thought-2");
    history.attach(second);
    history.mount();
    expect(second.scrollTo).not.toHaveBeenCalled();
    expect(second.scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it("restores the glued panel when transitioning to history in the same render pass", () => {
    const first = fakeScrollable();
    const live = createFollowOutputScrollController(true, "thought-same-pass");
    live.attach(first);
    live.mount();
    live.onScroll(metrics(400));
    live.unmount();

    const second = fakeScrollable();
    const history = createFollowOutputScrollController(false, "thought-same-pass");
    history.attach(second);
    history.mount();
    expect(second.scrollTo).not.toHaveBeenCalled();
    expect(second.scrollToEnd).toHaveBeenCalledWith({ animated: false });

    second.scrollToEnd.mockClear();
    history.onScroll(metrics(400));
    history.onContentSizeChange();
    history.onScroll(metrics(0));
    expect(second.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(second.scrollTo).not.toHaveBeenCalled();
  });

  it("restores a scrolled-up offset when transitioning to history in the same render pass", () => {
    const first = fakeScrollable();
    const live = createFollowOutputScrollController(true, "thought-scroll-pass");
    live.attach(first);
    live.mount();
    live.onScroll(metrics(400));
    live.onScroll(metrics(220));
    live.unmount();

    const second = fakeScrollable();
    const history = createFollowOutputScrollController(false, "thought-scroll-pass");
    history.attach(second);
    history.mount();
    expect(second.scrollToEnd).not.toHaveBeenCalled();
    expect(second.scrollTo).toHaveBeenCalledWith({ y: 220, animated: false });
  });

  it("does not pin a panel that never streamed when it remounts", () => {
    const first = fakeScrollable();
    const live = createFollowOutputScrollController(false, "static-tool");
    live.attach(first);
    live.mount();
    live.unmount();

    const second = fakeScrollable();
    const history = createFollowOutputScrollController(false, "static-tool");
    history.attach(second);
    history.mount();
    expect(second.scrollToEnd).not.toHaveBeenCalled();
    expect(second.scrollTo).not.toHaveBeenCalled();
  });

  it("ignores an unexpected 0 scroll reset on a glued overflowing panel after streaming ends", () => {
    const scrollable = fakeScrollable();
    const controller = createFollowOutputScrollController(true, "thought-reset-test");
    controller.attach(scrollable);
    controller.mount();

    controller.onScroll(metrics(400, 800, 400));

    controller.setEnabled(false);
    controller.mount();
    expect(scrollable.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    scrollable.scrollToEnd.mockClear();

    controller.onScroll(metrics(400, 800, 400));
    controller.onScroll(metrics(0, 800, 400));
    expect(scrollable.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(scrollable.scrollTo).not.toHaveBeenCalled();
  });

  it("does not snap a genuinely top-scrolled, detached panel back to its old position", () => {
    // Regression for a reader who detaches from the bottom and keeps scrolling up to the
    // real top: the first report of offsetY 0 right after a resize can be a native layout
    // echo (ignored, reapplies the restore), but once that single echo is consumed, a
    // further 0 report is the reader's own scroll and must stick.
    const scrollable = fakeScrollable();
    const controller = createFollowOutputScrollController(true, "detached-top-scroll");
    controller.attach(scrollable);
    controller.mount();
    controller.onContentSizeChange();

    controller.onScroll(metrics(400));
    controller.onScroll(metrics(100));
    expect(scrollable.scrollTo).not.toHaveBeenCalled();

    // New content streams in while detached: this resize arms one "layout reset" window,
    // and the native engine echoes a stale 0 before settling — that echo gets ignored and
    // the restore to 100 is reapplied.
    controller.onContentSizeChange();
    expect(scrollable.scrollTo).toHaveBeenCalledWith({ y: 100, animated: false });
    scrollable.scrollTo.mockClear();
    controller.onScroll(metrics(0));
    expect(scrollable.scrollTo).toHaveBeenCalledWith({ y: 100, animated: false });
    scrollable.scrollTo.mockClear();
    scrollable.scrollToEnd.mockClear();

    // The reader keeps dragging to the real top. This second 0 report is not a layout
    // reset anymore, so it must be accepted instead of snapped back to 100.
    controller.onScroll(metrics(0));
    expect(scrollable.scrollTo).not.toHaveBeenCalled();
    expect(scrollable.scrollToEnd).not.toHaveBeenCalled();

    // Proves the real position stuck: a later resize restores to the top the reader chose,
    // not the stale 100 from before.
    scrollable.scrollTo.mockClear();
    controller.onContentSizeChange();
    expect(scrollable.scrollTo).toHaveBeenCalledWith({ y: 0, animated: false });
  });
});

describe("follow-output scroll persistence", () => {
  it("evicts the oldest panel position once the cap is exceeded", () => {
    const total = MAX_PERSISTED_FOLLOW_OUTPUT_PANELS + 1;
    for (let i = 0; i < total; i += 1) {
      const controller = createFollowOutputScrollController(true, `panel-${i}`);
      controller.attach(fakeScrollable());
      controller.mount();
      // Scroll up and detach so the persisted state carries a restorable, non-default offset.
      controller.onScroll(metrics(400));
      controller.onScroll(metrics(100));
      controller.unmount();
    }

    // Evicted: falls back to a fresh, never-streamed state, so mounting it triggers no
    // reposition at all.
    const oldestScrollable = fakeScrollable();
    const oldest = createFollowOutputScrollController(false, "panel-0");
    oldest.attach(oldestScrollable);
    oldest.mount();
    expect(oldestScrollable.scrollTo).not.toHaveBeenCalled();
    expect(oldestScrollable.scrollToEnd).not.toHaveBeenCalled();

    // Still retained: restores to the detached offset that was persisted on unmount.
    const newestScrollable = fakeScrollable();
    const newest = createFollowOutputScrollController(false, `panel-${total - 1}`);
    newest.attach(newestScrollable);
    newest.mount();
    expect(newestScrollable.scrollTo).toHaveBeenCalledWith({ y: 100, animated: false });
  });
});
