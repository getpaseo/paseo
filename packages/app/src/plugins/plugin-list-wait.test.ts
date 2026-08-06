/**
 * @vitest-environment jsdom
 */
import { useEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_LIST_WAIT_MS, useBoundedPluginListWait } from "@/plugins/plugin-list-wait";

/** Records only what React actually committed — render passes it throws away do not run effects. */
function useRecordOnCommit(sink: boolean[], value: boolean): void {
  useEffect(() => {
    sink.push(value);
  });
}

describe("useBoundedPluginListWait", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function render(initialProps: { waiting: boolean; key: string }) {
    return renderHook((props) => useBoundedPluginListWait(props), { initialProps });
  }

  // Nothing else constrains the number: every other test here spends exactly
  // `PLUGIN_LIST_WAIT_MS`, so a minute-long deadline passes all of them while
  // being the unbounded hold this bound was added to remove.
  it("waits two seconds", () => {
    expect(PLUGIN_LIST_WAIT_MS).toBe(2_000);
  });

  it("gives up on a host that never answers", () => {
    const { result } = render({ waiting: true, key: "a" });

    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(PLUGIN_LIST_WAIT_MS));
    expect(result.current).toBe(false);
  });

  it("still waits just before the deadline", () => {
    const { result } = render({ waiting: true, key: "a" });

    act(() => vi.advanceTimersByTime(PLUGIN_LIST_WAIT_MS - 1));
    expect(result.current).toBe(true);
  });

  it("restarts the deadline when the key changes mid-wait", () => {
    const { result, rerender } = render({ waiting: true, key: "a" });

    act(() => vi.advanceTimersByTime(PLUGIN_LIST_WAIT_MS));
    expect(result.current).toBe(false);

    rerender({ waiting: true, key: "b" });
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(PLUGIN_LIST_WAIT_MS));
    expect(result.current).toBe(false);
  });

  // A host that reconnects keeps its id: `support` drops back to unknown, so
  // `waiting` goes true again under the same key and has to get a fresh
  // deadline rather than the spent one.
  it("stops waiting once the list lands, and waits again under the same key", () => {
    const { result, rerender } = render({ waiting: true, key: "a" });

    act(() => vi.advanceTimersByTime(PLUGIN_LIST_WAIT_MS));
    expect(result.current).toBe(false);

    rerender({ waiting: false, key: "a" });
    expect(result.current).toBe(false);

    rerender({ waiting: true, key: "a" });
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(PLUGIN_LIST_WAIT_MS));
    expect(result.current).toBe(false);
  });

  // Resetting in an effect instead of during render passes every test above and
  // still commits one render that says "done waiting" — long enough to mount
  // the fallback pane and fire its RPCs, which is the whole harm being avoided.
  it("commits no done-waiting render when the key changes mid-wait", () => {
    const committed: boolean[] = [];
    const { rerender } = renderHook(
      (props: { waiting: boolean; key: string }) => {
        const waiting = useBoundedPluginListWait(props);
        useRecordOnCommit(committed, waiting);
        return waiting;
      },
      { initialProps: { waiting: true, key: "a" } },
    );

    act(() => vi.advanceTimersByTime(PLUGIN_LIST_WAIT_MS));
    committed.length = 0;

    act(() => rerender({ waiting: true, key: "b" }));

    expect(committed).not.toContain(false);
    expect(committed).not.toEqual([]);
  });
});
