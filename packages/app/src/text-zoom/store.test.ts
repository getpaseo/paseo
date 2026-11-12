import AsyncStorage from "@react-native-async-storage/async-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAsyncStorageStub } from "../../test-stubs/async-storage";
import {
  TEXT_ZOOM_STORAGE_KEY,
  enablePinchTextZoom,
  getTextZoom,
  getTextZoomPreview,
  hydrateTextZoom,
  isPinchTextZoomEnabled,
  resetTextZoomForTests,
  setTextZoom,
  setTextZoomPreview,
  subscribeTextZoom,
} from "./store";

describe("text zoom store", () => {
  beforeEach(() => {
    clearAsyncStorageStub();
    resetTextZoomForTests();
  });
  afterEach(() => {
    resetTextZoomForTests();
  });

  it("keeps chat and terminal zoom apart and remembers them across launches", async () => {
    setTextZoom("chat", 1.4);
    setTextZoom("terminal", 0.8);
    expect(getTextZoom("chat")).toBe(1.4);
    expect(getTextZoom("terminal")).toBe(0.8);

    resetTextZoomForTests();
    expect(getTextZoom("chat")).toBe(1);
    await hydrateTextZoom();
    expect(getTextZoom("chat")).toBe(1.4);
    expect(getTextZoom("terminal")).toBe(0.8);
  });

  it("returns a surface to its settings size at zoom 1", async () => {
    setTextZoom("chat", 2);
    setTextZoom("chat", 1);
    expect(getTextZoom("chat")).toBe(1);
    expect(JSON.parse((await AsyncStorage.getItem(TEXT_ZOOM_STORAGE_KEY)) ?? "{}")).toEqual({
      chat: 1,
      terminal: 1,
    });
  });

  it("keeps a zoom set before the saved zooms load", async () => {
    await AsyncStorage.setItem(TEXT_ZOOM_STORAGE_KEY, JSON.stringify({ chat: 2, terminal: 2 }));
    setTextZoom("terminal", 1.5);
    await hydrateTextZoom();
    expect(getTextZoom("terminal")).toBe(1.5);
  });

  it("keeps pinch on while any enabler holds it, and clears its preview when the last lets go", () => {
    const first = enablePinchTextZoom("chat");
    const second = enablePinchTextZoom("chat");
    setTextZoomPreview({ surface: "chat", zoom: 1.3 });
    first();
    first();
    expect(isPinchTextZoomEnabled("chat")).toBe(true);
    expect(isPinchTextZoomEnabled("terminal")).toBe(false);
    second();
    expect(isPinchTextZoomEnabled("chat")).toBe(false);
    expect(getTextZoomPreview()).toBeNull();
  });

  it("notifies only on changes", () => {
    let calls = 0;
    const unsubscribe = subscribeTextZoom(() => {
      calls += 1;
    });
    setTextZoom("chat", 1.2);
    setTextZoom("chat", 1.2);
    setTextZoomPreview({ surface: "chat", zoom: 1.3 });
    setTextZoomPreview({ surface: "chat", zoom: 1.3 });
    unsubscribe();
    setTextZoom("chat", 1.5);
    expect(calls).toBe(2);
  });
});
