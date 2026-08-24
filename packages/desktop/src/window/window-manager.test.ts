import { describe, expect, it, vi } from "vitest";

import {
  applyMacWindowControlsUpdate,
  applyWindowControlsOverlayUpdate,
  createWindowControlsOverlayState,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  getMainWindowChromeOptions,
  getTitleBarOverlayOptions,
  readBadgeCount,
  readWindowControlsOverlayUpdate,
  readWindowTheme,
  resolveRuntimeTitleBarOverlayOptions,
  resolveWindowBounds,
  setupWindowStatePersistence,
  type PersistableWindow,
  type QuitEventTarget,
} from "./window-manager";
import type { WindowState, WindowStateStore } from "../settings/window-state";

describe("window-manager", () => {
  describe("readBadgeCount", () => {
    it("returns valid non-negative integers", () => {
      expect(readBadgeCount(0)).toBe(0);
      expect(readBadgeCount(3)).toBe(3);
    });

    it("falls back to zero for invalid payloads", () => {
      expect(readBadgeCount(undefined)).toBe(0);
      expect(readBadgeCount(null)).toBe(0);
      expect(readBadgeCount(Number.NaN)).toBe(0);
      expect(readBadgeCount(Number.POSITIVE_INFINITY)).toBe(0);
      expect(readBadgeCount(-1)).toBe(0);
      expect(readBadgeCount(1.5)).toBe(0);
      expect(readBadgeCount("2")).toBe(0);
      expect(readBadgeCount({ count: 2 })).toBe(0);
    });
  });

  describe("readWindowTheme", () => {
    it("accepts supported title bar themes", () => {
      expect(readWindowTheme("light")).toBe("light");
      expect(readWindowTheme("dark")).toBe("dark");
    });

    it("rejects invalid title bar themes", () => {
      expect(readWindowTheme(undefined)).toBeNull();
      expect(readWindowTheme("auto")).toBeNull();
      expect(readWindowTheme("system")).toBeNull();
    });
  });

  describe("getTitleBarOverlayOptions", () => {
    it("returns light title bar overlay colors", () => {
      expect(getTitleBarOverlayOptions("light")).toEqual({
        color: "#ffffff",
        symbolColor: "#09090b",
        height: 29,
      });
    });

    it("returns dark title bar overlay colors", () => {
      expect(getTitleBarOverlayOptions("dark")).toEqual({
        color: "#181B1A",
        symbolColor: "#e4e4e7",
        height: 29,
      });
    });
  });

  describe("readWindowControlsOverlayUpdate", () => {
    it("accepts partial runtime overlay updates", () => {
      expect(
        readWindowControlsOverlayUpdate({
          height: 48,
          backgroundColor: "#181B1A",
          trafficLightOffsetY: -5,
        }),
      ).toEqual({
        height: 48,
        backgroundColor: "#181B1A",
        trafficLightOffsetY: -5,
      });
    });

    it("rejects empty and invalid payloads", () => {
      expect(readWindowControlsOverlayUpdate(undefined)).toBeNull();
      expect(readWindowControlsOverlayUpdate({})).toBeNull();
      expect(readWindowControlsOverlayUpdate({ height: 0 })).toBeNull();
      expect(readWindowControlsOverlayUpdate({ backgroundColor: 12 })).toBeNull();
      expect(readWindowControlsOverlayUpdate({ trafficLightOffsetY: -11 })).toBeNull();
    });

    it("preserves fractional traffic-light offsets", () => {
      expect(readWindowControlsOverlayUpdate({ trafficLightOffsetY: 1.5 })).toEqual({
        trafficLightOffsetY: 1.5,
      });
    });
  });

  describe("resolveRuntimeTitleBarOverlayOptions", () => {
    it("applies the VS Code height minus border adjustment", () => {
      expect(
        resolveRuntimeTitleBarOverlayOptions({
          height: 48,
          backgroundColor: "#ffffff",
          foregroundColor: "#09090b",
        }),
      ).toEqual({
        color: "#ffffff",
        symbolColor: "#09090b",
        height: 47,
      });
    });
  });

  describe("applyWindowControlsOverlayUpdate", () => {
    it("merges cached colors with later runtime height updates", () => {
      const setTitleBarOverlay = vi.fn();
      let state = createWindowControlsOverlayState("dark");

      state = applyWindowControlsOverlayUpdate({
        win: { setTitleBarOverlay },
        current: state,
        update: {
          backgroundColor: "#181B1A",
          foregroundColor: "#e4e4e7",
        },
      });

      state = applyWindowControlsOverlayUpdate({
        win: { setTitleBarOverlay },
        current: state,
        update: { height: 48 },
      });

      expect(state).toEqual({
        height: 48,
        backgroundColor: "#181B1A",
        foregroundColor: "#e4e4e7",
      });
      expect(setTitleBarOverlay).toHaveBeenNthCalledWith(1, {
        color: "#181B1A",
        symbolColor: "#e4e4e7",
        height: 28,
      });
      expect(setTitleBarOverlay).toHaveBeenNthCalledWith(2, {
        color: "#181B1A",
        symbolColor: "#e4e4e7",
        height: 47,
      });
    });
  });

  describe("applyMacWindowControlsUpdate", () => {
    it("uses the focus and normal traffic-light positions", () => {
      const setWindowButtonPosition = vi.fn();

      applyMacWindowControlsUpdate({
        win: { setWindowButtonPosition },
        update: { trafficLightOffsetY: -5 },
      });
      applyMacWindowControlsUpdate({
        win: { setWindowButtonPosition },
        update: { trafficLightOffsetY: 0.5 },
      });

      expect(setWindowButtonPosition).toHaveBeenNthCalledWith(1, { x: 16, y: 9 });
      expect(setWindowButtonPosition).toHaveBeenNthCalledWith(2, { x: 16, y: 14.5 });
    });
  });

  describe("getMainWindowChromeOptions", () => {
    it("uses frameless hidden title bars with overlay on windows", () => {
      expect(
        getMainWindowChromeOptions({
          platform: "win32",
          theme: "dark",
        }),
      ).toEqual({
        titleBarStyle: "hidden",
        frame: false,
        autoHideMenuBar: true,
        titleBarOverlay: {
          color: "#181B1A",
          symbolColor: "#e4e4e7",
          height: 29,
        },
      });
    });

    it("uses frameless hidden title bars with overlay on linux", () => {
      expect(
        getMainWindowChromeOptions({
          platform: "linux",
          theme: "light",
        }),
      ).toEqual({
        titleBarStyle: "hidden",
        frame: false,
        autoHideMenuBar: true,
        titleBarOverlay: {
          color: "#ffffff",
          symbolColor: "#09090b",
          height: 29,
        },
      });
    });

    it("keeps the mac traffic-light path separate", () => {
      expect(
        getMainWindowChromeOptions({
          platform: "darwin",
          theme: "dark",
        }),
      ).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: true,
        trafficLightPosition: { x: 16, y: 14 },
      });
    });
  });

  describe("resolveWindowBounds", () => {
    it("falls back to the default size when no state is saved", () => {
      expect(resolveWindowBounds(null)).toEqual({
        width: DEFAULT_WINDOW_WIDTH,
        height: DEFAULT_WINDOW_HEIGHT,
      });
    });

    it("restores the full size and position", () => {
      expect(
        resolveWindowBounds({ x: 120, y: 80, width: 1024, height: 720, isMaximized: false }),
      ).toEqual({ width: 1024, height: 720, x: 120, y: 80 });
    });

    it("omits the position when only the size was persisted", () => {
      expect(resolveWindowBounds({ width: 1024, height: 720, isMaximized: true })).toEqual({
        width: 1024,
        height: 720,
      });
    });
  });

  describe("setupWindowStatePersistence", () => {
    function createFakeWindow(): PersistableWindow & {
      emit(event: string): void;
      setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
    } {
      const handlers = new Map<string, Array<() => void>>();
      let bounds = { x: 0, y: 0, width: 800, height: 600 };

      return {
        isMinimized: () => false,
        isFullScreen: () => false,
        isMaximized: () => false,
        getNormalBounds: () => bounds,
        on(event, handler) {
          const existing = handlers.get(event) ?? [];
          existing.push(handler);
          handlers.set(event, existing);
          return this;
        },
        emit(event) {
          for (const handler of handlers.get(event) ?? []) {
            handler();
          }
        },
        setBounds(next) {
          bounds = next;
        },
      };
    }

    function createFakeQuitEvents(): QuitEventTarget & { emit(): void } {
      let handlers: Array<() => void> = [];
      return {
        on(_event, handler) {
          handlers.push(handler);
          return this;
        },
        removeListener(_event, handler) {
          handlers = handlers.filter((existing) => existing !== handler);
          return this;
        },
        emit() {
          // for-of holds the array it started on, so a listener removing itself
          // mid-emit (removeListener reassigns `handlers`) can't skip a peer.
          for (const handler of handlers) {
            handler();
          }
        },
      };
    }

    /**
     * A store that reproduces the real one-way `finalized` latch: once saveSync
     * lands, every later save() is dropped (see settings/window-state.ts).
     */
    function createLatchingStore(): WindowStateStore & { written: WindowState[] } {
      const written: WindowState[] = [];
      let finalized = false;
      return {
        written,
        load: async () => null,
        async save(state) {
          if (finalized) {
            return;
          }
          written.push(state);
        },
        saveSync(state) {
          finalized = true;
          written.push(state);
        },
      };
    }

    it("flushes geometry on an ordinary window close", () => {
      const win = createFakeWindow();
      const store = createLatchingStore();
      setupWindowStatePersistence(win, store, { quitEvents: createFakeQuitEvents() });

      win.setBounds({ x: 10, y: 20, width: 1000, height: 700 });
      win.emit("close");

      expect(store.written).toEqual([
        { x: 10, y: 20, width: 1000, height: 700, isMaximized: false },
      ]);
    });

    // Cmd+W, the red button, and closing one of several windows all happen with
    // the quit uncommitted. Gating the close flush on quit-committed would drop
    // every one of them, and `closed` then unregisters the before-quit listener,
    // so the geometry would never be written again.
    it("still flushes on close when the quit is not committed", () => {
      const win = createFakeWindow();
      const store = createLatchingStore();
      setupWindowStatePersistence(win, store, {
        quitEvents: createFakeQuitEvents(),
        gates: { willVetoClose: () => false, isQuitCommitted: () => false },
      });

      win.emit("close");

      expect(store.written).toHaveLength(1);
    });

    it("does not flush a close that is about to be vetoed", () => {
      const win = createFakeWindow();
      const store = createLatchingStore();
      setupWindowStatePersistence(win, store, {
        quitEvents: createFakeQuitEvents(),
        gates: { willVetoClose: () => true, isQuitCommitted: () => false },
      });

      win.emit("close");

      expect(store.written).toEqual([]);
    });

    it("does not flush a before-quit the user can still cancel", () => {
      const win = createFakeWindow();
      const store = createLatchingStore();
      const quitEvents = createFakeQuitEvents();
      setupWindowStatePersistence(win, store, {
        quitEvents,
        gates: { willVetoClose: () => true, isQuitCommitted: () => false },
      });

      quitEvents.emit();

      expect(store.written).toEqual([]);
    });

    it("flushes on before-quit once the quit is committed", () => {
      const win = createFakeWindow();
      const store = createLatchingStore();
      const quitEvents = createFakeQuitEvents();
      let committed = false;
      setupWindowStatePersistence(win, store, {
        quitEvents,
        gates: { willVetoClose: () => !committed, isQuitCommitted: () => committed },
      });

      quitEvents.emit();
      committed = true;
      quitEvents.emit();

      expect(store.written).toHaveLength(1);
    });

    // The regression this gating exists for: a cancelled quit used to run the
    // synchronous final write, latching the store, after which resizing the
    // window and quitting for real persisted nothing.
    it("still persists the final geometry after the user cancels a quit", async () => {
      const win = createFakeWindow();
      const store = createLatchingStore();
      const quitEvents = createFakeQuitEvents();
      let committed = false;
      setupWindowStatePersistence(win, store, {
        quitEvents,
        gates: { willVetoClose: () => !committed, isQuitCommitted: () => committed },
      });

      // Cmd+Q, then Cancel.
      quitEvents.emit();

      // Resize, then quit for real.
      win.setBounds({ x: 5, y: 5, width: 1280, height: 800 });
      committed = true;
      quitEvents.emit();

      expect(store.written).toEqual([{ x: 5, y: 5, width: 1280, height: 800, isMaximized: false }]);
    });

    it("stops listening for quits once the window is gone", () => {
      const win = createFakeWindow();
      const store = createLatchingStore();
      const quitEvents = createFakeQuitEvents();
      setupWindowStatePersistence(win, store, {
        quitEvents,
        gates: { willVetoClose: () => false, isQuitCommitted: () => true },
      });

      win.emit("closed");
      quitEvents.emit();

      expect(store.written).toEqual([]);
    });
  });
});
