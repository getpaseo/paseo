// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type MarkdownPhase, useRevealedText } from "./use-revealed-text";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useRevealedText", () => {
  it("does not expose the reveal backlog when streaming completes", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (frameId: number) => {
      frames.delete(frameId);
    });
    const runNextFrame = (timestamp: number) => {
      const entry = frames.entries().next().value;
      if (!entry) {
        throw new Error("Expected a pending animation frame");
      }
      const [frameId, frame] = entry;
      frames.delete(frameId);
      frame(timestamp);
    };

    const initialText = "Visible thought. ";
    const finalText = `${initialText}${"Buffered reasoning text. ".repeat(20)}`;
    const { result, rerender } = renderHook(
      ({ text, phase }: { text: string; phase: MarkdownPhase }) => useRevealedText(text, phase),
      { initialProps: { text: initialText, phase: "streaming" as MarkdownPhase } },
    );

    rerender({ text: finalText, phase: "streaming" });
    expect(result.current).toBe(initialText);

    act(() => {
      runNextFrame(16.7);
    });
    expect(result.current.length).toBeGreaterThan(initialText.length);
    expect(result.current.length).toBeLessThan(finalText.length);

    rerender({ text: finalText, phase: "complete" });

    expect(result.current.length).toBeLessThan(finalText.length);

    act(() => {
      let timestamp = 33.4;
      let frameCount = 0;
      while (frames.size > 0 && frameCount < 1_000) {
        runNextFrame(timestamp);
        timestamp += 16.7;
        frameCount += 1;
      }
      expect(frameCount).toBeLessThan(1_000);
    });

    expect(result.current).toBe(finalText);
  });
});
