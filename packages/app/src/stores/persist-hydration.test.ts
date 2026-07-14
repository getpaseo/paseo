import { describe, expect, it, vi } from "vitest";
import { subscribeToPersistHydration, type PersistHydrationApi } from "./persist-hydration";

function createHydrationApi(): PersistHydrationApi<object> & {
  finish: () => void;
  subscribed: () => boolean;
} {
  let hydrated = false;
  let listener: ((state: object) => void) | null = null;
  return {
    hasHydrated: () => hydrated,
    onFinishHydration: (nextListener) => {
      listener = nextListener;
      return () => {
        listener = null;
      };
    },
    finish: () => {
      hydrated = true;
      listener?.({});
    },
    subscribed: () => listener !== null,
  };
}

describe("subscribeToPersistHydration", () => {
  it("observes hydration that finishes after the render-time check but before effect setup", () => {
    const api = createHydrationApi();
    const onHydrated = vi.fn();
    api.finish();

    const unsubscribe = subscribeToPersistHydration(api, onHydrated);

    expect(onHydrated).toHaveBeenCalledTimes(1);
    expect(api.subscribed()).toBe(true);
    unsubscribe();
    expect(api.subscribed()).toBe(false);
  });

  it("notifies once when completion races the immediate check", () => {
    const api = createHydrationApi();
    const onHydrated = vi.fn();
    const originalSubscribe = api.onFinishHydration;
    api.onFinishHydration = (listener) => {
      const unsubscribe = originalSubscribe(listener);
      api.finish();
      return unsubscribe;
    };

    subscribeToPersistHydration(api, onHydrated);

    expect(onHydrated).toHaveBeenCalledTimes(1);
  });
});
