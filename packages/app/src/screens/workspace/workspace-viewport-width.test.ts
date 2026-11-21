/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceViewportWidthStore,
  useWorkspaceViewportWidth,
} from "./workspace-viewport-width";

describe("workspace viewport width store", () => {
  it("does not publish a sub-point change", () => {
    const store = createWorkspaceViewportWidthStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.set(924);
    store.set(924.4);
    store.set(923.2);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(924);
  });

  it("publishes a change of a point or more and keeps the last width while hidden", () => {
    const store = createWorkspaceViewportWidthStore();
    store.set(924);
    store.set(925);
    store.set(0);
    expect(store.get()).toBe(925);
  });

  it("re-renders a subscribed reader only for published changes", () => {
    const store = createWorkspaceViewportWidthStore();
    store.set(924);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useWorkspaceViewportWidth(store, true);
    });
    renders = 0;

    act(() => store.set(924.6));
    expect(renders).toBe(0);

    act(() => store.set(900));
    expect(renders).toBe(1);
    expect(result.current).toBe(900);
  });

  it("does not re-render a disabled reader and catches up once enabled", () => {
    const store = createWorkspaceViewportWidthStore();
    store.set(924);
    let renders = 0;
    const { result, rerender } = renderHook(
      ({ enabled }) => {
        renders += 1;
        return useWorkspaceViewportWidth(store, enabled);
      },
      { initialProps: { enabled: false } },
    );
    renders = 0;

    act(() => {
      for (let width = 900; width > 700; width -= 10) store.set(width);
    });
    expect(renders).toBe(0);

    rerender({ enabled: true });
    expect(result.current).toBe(710);
  });
});
