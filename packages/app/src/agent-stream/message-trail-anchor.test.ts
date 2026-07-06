import { describe, expect, it, vi } from "vitest";
import { createTrailAnchorStore } from "./message-trail-anchor";

describe("createTrailAnchorStore", () => {
  it("starts with an empty snapshot", () => {
    const store = createTrailAnchorStore();

    expect(store.getSnapshot()).toEqual({ currentId: null });
  });

  it("publishes a new snapshot and notifies listeners", () => {
    const store = createTrailAnchorStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.publish({ currentId: "u1" });

    expect(store.getSnapshot()).toEqual({ currentId: "u1" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ currentId: "u1" });
  });

  it("does not notify when publishing an identical snapshot", () => {
    const store = createTrailAnchorStore();
    store.publish({ currentId: "u1" });

    const listener = vi.fn();
    store.subscribe(listener);

    store.publish({ currentId: "u1" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("treats a changed currentId as a new snapshot", () => {
    const store = createTrailAnchorStore();
    store.publish({ currentId: "u1" });

    const listener = vi.fn();
    store.subscribe(listener);

    store.publish({ currentId: "u2" });

    expect(store.getSnapshot()).toEqual({ currentId: "u2" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ currentId: "u2" });
  });

  it("treats a null→non-null currentId transition as a change", () => {
    const store = createTrailAnchorStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.publish({ currentId: "u1" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ currentId: "u1" });
  });

  it("does not notify when publishing the initial empty snapshot again", () => {
    const store = createTrailAnchorStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.publish({ currentId: null });

    expect(listener).not.toHaveBeenCalled();
  });

  it("returns the latest snapshot from getSnapshot after several publishes", () => {
    const store = createTrailAnchorStore();

    store.publish({ currentId: "u1" });
    store.publish({ currentId: "u2" });
    store.publish({ currentId: "u3" });

    expect(store.getSnapshot()).toEqual({ currentId: "u3" });
  });

  it("delivers the new snapshot value to a late subscriber's first notify", () => {
    const store = createTrailAnchorStore();
    store.publish({ currentId: "u1" });

    const listener = vi.fn();
    store.subscribe(listener);

    store.publish({ currentId: "u2" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ currentId: "u2" });
  });

  it("stops notifying after unsubscribe", () => {
    const store = createTrailAnchorStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.publish({ currentId: "u1" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies multiple subscribed listeners independently", () => {
    const store = createTrailAnchorStore();
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    store.subscribe(listenerA);
    const unsubscribeB = store.subscribe(listenerB);

    store.publish({ currentId: "u1" });
    unsubscribeB();
    store.publish({ currentId: "u2" });

    expect(listenerA).toHaveBeenCalledTimes(2);
    expect(listenerB).toHaveBeenCalledTimes(1);
  });
});
