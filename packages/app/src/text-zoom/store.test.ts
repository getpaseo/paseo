import AsyncStorage from "@react-native-async-storage/async-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAsyncStorageStub } from "../../test-stubs/async-storage";
import {
  TEXT_ZOOM_STORAGE_KEY,
  enablePinchTextZoom,
  applyPinchTextZoom,
  beginTextZoomPinch,
  endTextZoomPinch,
  getTextZoom,
  getTextZoomPinch,
  hydrateTextZoom,
  isPinchTextZoomEnabled,
  resetTextZoomForTests,
  setTextZoom,
  subscribeTextZoom,
} from "./store";

async function savedZooms(): Promise<unknown> {
  return JSON.parse((await AsyncStorage.getItem(TEXT_ZOOM_STORAGE_KEY)) ?? "null");
}

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
    expect(await savedZooms()).toEqual({ chat: 1, terminal: 1, files: 1 });
  });

  it("keeps a zoom set before the saved zooms load", async () => {
    await AsyncStorage.setItem(TEXT_ZOOM_STORAGE_KEY, JSON.stringify({ chat: 2, terminal: 2 }));
    setTextZoom("terminal", 1.5);
    await hydrateTextZoom();
    expect(getTextZoom("terminal")).toBe(1.5);
  });

  it("keeps pinch on while any enabler holds it, and ends a pinch when the last lets go", () => {
    const first = enablePinchTextZoom("chat");
    const second = enablePinchTextZoom("chat");
    beginTextZoomPinch("chat", null);
    first();
    first();
    expect(isPinchTextZoomEnabled("chat")).toBe(true);
    expect(isPinchTextZoomEnabled("terminal")).toBe(false);
    second();
    expect(isPinchTextZoomEnabled("chat")).toBe(false);
    expect(getTextZoomPinch()).toBeNull();
  });

  it("changes the size live during a pinch and saves it once, when the pinch ends", async () => {
    beginTextZoomPinch("terminal", { x: 10, y: 20 });
    applyPinchTextZoom(1.1);
    applyPinchTextZoom(1.25);
    expect(getTextZoom("terminal")).toBe(1.25);
    expect(await savedZooms()).toBeNull();
    endTextZoomPinch();
    expect(getTextZoomPinch()).toBeNull();
    expect(await savedZooms()).toEqual({ chat: 1, terminal: 1.25, files: 1 });
  });

  it("keeps every surface's zoom apart", () => {
    for (const [surface, zoom] of [
      ["chat", 1.5],
      ["terminal", 0.75],
      ["files", 2],
    ] as const) {
      const before = {
        chat: getTextZoom("chat"),
        terminal: getTextZoom("terminal"),
        files: getTextZoom("files"),
      };
      beginTextZoomPinch(surface, null);
      applyPinchTextZoom(zoom);
      endTextZoomPinch();
      expect(getTextZoom(surface)).toBe(zoom);
      for (const other of ["chat", "terminal", "files"] as const) {
        if (other !== surface) expect(getTextZoom(other)).toBe(before[other]);
      }
    }
    setTextZoom("chat", 1);
    expect(getTextZoom("terminal")).toBe(0.75);
    expect(getTextZoom("files")).toBe(2);
  });

  it("notifies only on changes", () => {
    let calls = 0;
    const unsubscribe = subscribeTextZoom(() => {
      calls += 1;
    });
    setTextZoom("chat", 1.2);
    setTextZoom("chat", 1.2);
    unsubscribe();
    setTextZoom("chat", 1.5);
    expect(calls).toBe(1);
  });
});
