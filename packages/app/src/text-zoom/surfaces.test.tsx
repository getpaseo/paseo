// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { darkTheme } from "@/styles/theme";
import { createMarkdownStyles } from "@/components/markdown/styles";
import { sourceLineMetrics } from "@/file-panels/source/readonly/line-metrics";
import { zoomedFontSize, type TextZoomSurface } from "./model";
import { startTextZoomPinch } from "./pinch-session";
import { TextZoomScope, useScopedTextZoom } from "./scope";
import { enablePinchTextZoom, resetTextZoomForTests, useTextZoom } from "./store";
import type { FrameScheduler } from "./live";

const immediateFrames: FrameScheduler = {
  request: (callback) => {
    callback();
    return 0;
  },
  cancel: () => {},
};

function scoped(surface: TextZoomSurface) {
  return ({ children }: { children: ReactNode }) => (
    <TextZoomScope surface={surface}>{children}</TextZoomScope>
  );
}

function pinch(surface: TextZoomSurface, scale: number) {
  const session = startTextZoomPinch(surface, null, immediateFrames);
  session.scale(scale);
  session.end();
}

describe("text zoom surfaces stay independent", () => {
  beforeEach(() => resetTextZoomForTests());
  afterEach(() => resetTextZoomForTests());

  it("a chat pinch changes what the chat renders and nothing the terminal or file views render", () => {
    enablePinchTextZoom("chat");
    const chat = renderHook(() => useScopedTextZoom(), { wrapper: scoped("chat") });
    const files = renderHook(() => useScopedTextZoom(), { wrapper: scoped("files") });
    // The terminal pane reads its own surface, not the scope.
    const terminal = renderHook(() => useTextZoom("terminal"));
    const unscoped = renderHook(() => useScopedTextZoom());

    act(() => pinch("chat", 1.5));

    expect(chat.result.current).toBe(1.5);
    expect(terminal.result.current).toBe(1);
    expect(files.result.current).toBe(1);
    expect(unscoped.result.current).toBe(1);

    const code = darkTheme.fontSize.code;
    const chatCode = createMarkdownStyles(darkTheme, { blockGap: 16, zoom: chat.result.current })
      .markdownStyle.codeBlock?.fontSize;
    expect(chatCode).toBe(Math.round(code * 1.5));
    expect(zoomedFontSize(code, terminal.result.current)).toBe(code);
    expect(sourceLineMetrics(code, files.result.current).fontSize).toBe(code);
  });

  it("a terminal pinch leaves chat and file views where they were", () => {
    const chat = renderHook(() => useScopedTextZoom(), { wrapper: scoped("chat") });
    const files = renderHook(() => useScopedTextZoom(), { wrapper: scoped("files") });
    const terminal = renderHook(() => useTextZoom("terminal"));

    act(() => pinch("chat", 1.25));
    act(() => pinch("terminal", 0.5));
    act(() => pinch("files", 2));

    expect(chat.result.current).toBe(1.25);
    expect(terminal.result.current).toBe(0.5);
    expect(files.result.current).toBe(2);
  });
});
