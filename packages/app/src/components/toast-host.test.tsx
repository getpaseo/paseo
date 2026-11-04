// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewport, useToastHost } from "./toast-host";

vi.mock("react-native-reanimated", async () => {
  const { View } = await import("react-native");
  const fade = { duration: () => fade };
  class Keyframe {
    duration() {
      return this;
    }
  }
  return { default: { View }, FadeIn: fade, FadeOut: fade, Keyframe };
});

function Host({ durationMs }: { durationMs: number | null }) {
  const { api, toast, dismiss } = useToastHost();
  const show = useCallback(() => api.show("Agent started", { durationMs }), [api, durationMs]);
  return (
    <>
      <button type="button" onClick={show}>
        show
      </button>
      <ToastViewport toast={toast} onDismiss={dismiss} placement="panel" />
    </>
  );
}

describe("ToastViewport dismiss button", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("closes a timed toast right away", () => {
    render(<Host durationMs={60_000} />);
    fireEvent.click(screen.getByText("show"));
    expect(screen.getByTestId("app-toast-message")).toBeTruthy();

    fireEvent.click(screen.getByTestId("app-toast-dismiss"));
    expect(screen.queryByTestId("app-toast-message")).toBeNull();
  });

  it("still closes a timed toast on its own", () => {
    render(<Host durationMs={3000} />);
    fireEvent.click(screen.getByText("show"));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByTestId("app-toast-message")).toBeNull();
  });

  it("waits while the pointer is over the toast, then closes", () => {
    render(<Host durationMs={3000} />);
    fireEvent.click(screen.getByText("show"));
    fireEvent.pointerEnter(screen.getByTestId("app-toast").firstElementChild as Element);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByTestId("app-toast-message")).toBeTruthy();

    fireEvent.pointerLeave(screen.getByTestId("app-toast").firstElementChild as Element);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByTestId("app-toast-message")).toBeNull();
  });

  it("offers no dismiss button on a toast without a duration", () => {
    render(<Host durationMs={null} />);
    fireEvent.click(screen.getByText("show"));
    expect(screen.getByTestId("app-toast-message")).toBeTruthy();
    expect(screen.queryByTestId("app-toast-dismiss")).toBeNull();
  });
});

describe("useToastHost", () => {
  it("dismisses the toast that show returned the dismiss for", () => {
    const { result } = renderHook(() => useToastHost());

    let dismiss = () => {};
    act(() => {
      dismiss = result.current.api.show("Uploading image…", { durationMs: null });
    });
    expect(result.current.toast?.content).toBe("Uploading image…");

    act(() => dismiss());
    expect(result.current.toast).toBeNull();
  });

  it("leaves a newer toast in place when an older one is dismissed", () => {
    const { result } = renderHook(() => useToastHost());

    let dismissUploading = () => {};
    act(() => {
      dismissUploading = result.current.api.show("Uploading image…", { durationMs: null });
    });
    act(() => {
      result.current.api.show("Image uploaded", { variant: "success" });
    });

    act(() => dismissUploading());
    expect(result.current.toast?.content).toBe("Image uploaded");
  });
});
