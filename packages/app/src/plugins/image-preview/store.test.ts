import { describe, expect, it, vi } from "vitest";
import { createPluginImagePreviewStore } from "./store";

const IMAGES = [
  { uri: "data:image/png;base64,AAAA", name: "first.png" },
  { uri: "data:image/png;base64,BBBB" },
  { uri: "data:image/png;base64,CCCC", name: "third.png" },
];

describe("plugin image preview store", () => {
  it("opens at the requested image, clamped to the list", () => {
    const store = createPluginImagePreviewStore();
    store.open({ images: IMAGES, index: 2 });
    expect(store.getSnapshot()).toEqual({ images: IMAGES, index: 2 });

    store.open({ images: IMAGES, index: 9 });
    expect(store.getSnapshot()?.index).toBe(2);
    store.open({ images: IMAGES, index: -3 });
    expect(store.getSnapshot()?.index).toBe(0);
    store.open({ images: IMAGES });
    expect(store.getSnapshot()?.index).toBe(0);
  });

  it("refuses an empty list and keeps only entries with a uri", () => {
    const store = createPluginImagePreviewStore();
    expect(() => store.open({ images: [] })).toThrow("at least one image");
    expect(() => store.open({ images: [{ uri: "" }] })).toThrow("at least one image");
    expect(store.getSnapshot()).toBeNull();

    store.open({
      images: [{ uri: "data:image/png;base64,AAAA", name: 3 }, { name: "no-uri" }] as never,
    });
    expect(store.getSnapshot()).toEqual({
      images: [{ uri: "data:image/png;base64,AAAA" }],
      index: 0,
    });
  });

  it("does not follow later mutation of the caller's array", () => {
    const store = createPluginImagePreviewStore();
    const images = [...IMAGES];
    store.open({ images, index: 1 });
    images.splice(0, images.length);
    store.select(2);
    expect(store.getSnapshot()).toEqual({ images: IMAGES, index: 2 });
  });

  it("moves between images without leaving the list", () => {
    const store = createPluginImagePreviewStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.open({ images: IMAGES, index: 1 });

    store.select(2);
    expect(store.getSnapshot()?.index).toBe(2);
    store.select(3);
    expect(store.getSnapshot()?.index).toBe(2);
    store.select(-1);
    expect(store.getSnapshot()?.index).toBe(0);
    // open, 2, and 0: the clamped select that changed nothing did not notify.
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("replaces an open preview and closes once", () => {
    const store = createPluginImagePreviewStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.open({ images: IMAGES, index: 2 });
    store.open({ images: IMAGES.slice(0, 1) });
    expect(store.getSnapshot()).toEqual({ images: IMAGES.slice(0, 1), index: 0 });

    store.close();
    store.close();
    store.select(1);
    expect(store.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
