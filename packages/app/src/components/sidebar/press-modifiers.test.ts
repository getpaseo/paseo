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

  it("hands the captured intent to pointerup exactly once and arms the suppression", () => {
    stubApplePlatform(true);
    captureWorkspaceRowPointerModifiers(pointerEvent({ metaKey: true }));
    const intent: WorkspaceRowPressIntent | null = consumeWorkspaceRowPointerUpIntent();
    expect(intent).toEqual({ kind: "toggle" });
    expect(consumeWorkspaceRowPressSuppression()).toBe(true);
    expect(consumeWorkspaceRowPressSuppression()).toBe(false);
  });

  it("a plain pointerup disarms the suppression, healing an undelivered ctrl press", () => {
    stubApplePlatform(false);
    captureWorkspaceRowPointerModifiers(pointerEvent({ ctrlKey: true }));
    expect(consumeWorkspaceRowPointerUpIntent()).toEqual({ kind: "toggle" });
    // A ctrl press never arrives (the responder skips it), so the flag stays armed until the
    // next click's own pointerup clears it — that plain click must navigate normally.
    captureWorkspaceRowPointerModifiers(pointerEvent({}));
    expect(consumeWorkspaceRowPointerUpIntent()).toBeNull();
    expect(consumeWorkspaceRowPressSuppression()).toBe(false);
  });

  it("captures Shift as a range", () => {
    stubApplePlatform(false);
    captureWorkspaceRowPointerModifiers(pointerEvent({ shiftKey: true }));
    expect(consumeWorkspaceRowPointerUpIntent()).toEqual({ kind: "range" });
  });
});
