import { afterEach, describe, expect, it } from "vitest";
import {
  captureWorkspaceRowPointerModifiers,
  consumeWorkspaceRowPointerUpIntent,
  consumeWorkspaceRowPressSuppression,
  resolveWorkspaceRowPressIntent,
  setApplePlatformOverrideForTests,
  type WorkspaceRowPressIntent,
} from "@/components/sidebar/press-modifiers";

describe("resolveWorkspaceRowPressIntent", () => {
  it("routes Cmd to toggle on Apple platforms and ignores Ctrl there (Ctrl+click is the context menu)", () => {
    expect(
      resolveWorkspaceRowPressIntent({
        applePlatform: true,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
    expect(
      resolveWorkspaceRowPressIntent({
        applePlatform: true,
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
      }),
    ).toEqual({ kind: "toggle" });
  });

  it("routes Ctrl to toggle elsewhere and ignores Cmd there", () => {
    expect(
      resolveWorkspaceRowPressIntent({
        applePlatform: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
      }),
    ).toEqual({ kind: "toggle" });
    expect(
      resolveWorkspaceRowPressIntent({
        applePlatform: false,
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
      }),
    ).toBeNull();
  });

  it("Shift always means range and wins over the multi-select key", () => {
    expect(
      resolveWorkspaceRowPressIntent({
        applePlatform: true,
        ctrlKey: false,
        metaKey: true,
        shiftKey: true,
      }),
    ).toEqual({ kind: "range" });
    expect(
      resolveWorkspaceRowPressIntent({
        applePlatform: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
      }),
    ).toEqual({ kind: "range" });
  });

  it("no modifiers means a plain press", () => {
    expect(
      resolveWorkspaceRowPressIntent({
        applePlatform: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
  });
});

describe("capture and pointerup", () => {
  afterEach(() => {
    setApplePlatformOverrideForTests(null);
    captureWorkspaceRowPointerModifiers({});
    consumeWorkspaceRowPointerUpIntent();
    consumeWorkspaceRowPressSuppression();
  });

  function stubApplePlatform(isApple: boolean): void {
    setApplePlatformOverrideForTests(isApple);
  }

  function pointerEvent(modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) {
    return modifiers as unknown as Parameters<typeof captureWorkspaceRowPointerModifiers>[0];
  }

  function clickAt(
    clientX: number,
    clientY: number,
    detail = 1,
  ): Parameters<typeof consumeWorkspaceRowPressSuppression>[0] {
    return { nativeEvent: { clientX, clientY, detail, type: "click" } };
  }

  it("hands the captured intent to pointerup exactly once and arms the suppression", () => {
    stubApplePlatform(true);
    captureWorkspaceRowPointerModifiers(pointerEvent({ metaKey: true }));
    const intent: WorkspaceRowPressIntent | null = consumeWorkspaceRowPointerUpIntent(
      clickAt(40, 40),
    );
    expect(intent).toEqual({ kind: "toggle" });
    // React-native-web invokes onPress from the click that repeats the pointerup's coordinates.
    expect(consumeWorkspaceRowPressSuppression(clickAt(40, 40))).toBe(true);
    expect(consumeWorkspaceRowPressSuppression(clickAt(40, 40))).toBe(false);
  });

  it("a plain pointerup disarms the suppression, healing an undelivered ctrl press", () => {
    stubApplePlatform(false);
    captureWorkspaceRowPointerModifiers(pointerEvent({ ctrlKey: true }));
    expect(consumeWorkspaceRowPointerUpIntent(clickAt(12, 34))).toEqual({ kind: "toggle" });
    // A ctrl press never arrives (the responder skips it), so the flag stays armed until the
    // next click's own pointerup clears it — that plain click must navigate normally.
    captureWorkspaceRowPointerModifiers(pointerEvent({}));
    expect(consumeWorkspaceRowPointerUpIntent(clickAt(56, 78))).toBeNull();
    expect(consumeWorkspaceRowPressSuppression(clickAt(56, 78))).toBe(false);
  });

  it("a keyboard press bypasses a stale undelivered ctrl-click suppression", () => {
    stubApplePlatform(false);
    captureWorkspaceRowPointerModifiers(pointerEvent({ ctrlKey: true }));
    expect(consumeWorkspaceRowPointerUpIntent(clickAt(12, 34))).toEqual({ kind: "toggle" });
    // Enter/Space dispatch a click with detail 0 and no pointer coordinates; it must not be
    // swallowed by the leftover flag.
    expect(consumeWorkspaceRowPressSuppression(clickAt(0, 0, 0))).toBe(false);
    expect(consumeWorkspaceRowPressSuppression(clickAt(12, 34, 0))).toBe(false);
  });

  it("a press at different coordinates is not suppressed", () => {
    stubApplePlatform(false);
    captureWorkspaceRowPointerModifiers(pointerEvent({ ctrlKey: true }));
    expect(consumeWorkspaceRowPointerUpIntent(clickAt(12, 34))).toEqual({ kind: "toggle" });
    expect(consumeWorkspaceRowPressSuppression(clickAt(56, 78))).toBe(false);
  });

  it("captures Shift as a range", () => {
    stubApplePlatform(false);
    captureWorkspaceRowPointerModifiers(pointerEvent({ shiftKey: true }));
    expect(consumeWorkspaceRowPointerUpIntent(clickAt(9, 9))).toEqual({ kind: "range" });
  });
});
