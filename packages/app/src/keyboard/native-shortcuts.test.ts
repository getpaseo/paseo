import { describe, expect, it } from "vitest";
import { buildEffectiveBindings } from "./keyboard-shortcuts";
import { createKeyboardPipeline } from "./internal/pipeline";
import { createOverlayRegistry } from "./internal/overlays";
import { nativeKeyboardInput } from "./internal/sources/contract";

function keyboardEvent(key: string, code: string, isMac = true) {
  return {
    key,
    code,
    altKey: false,
    ctrlKey: !isMac,
    metaKey: isMac,
    shiftKey: false,
    repeat: false,
    preventDefault() {},
    stopPropagation() {},
  };
}

describe("shared keyboard source pipeline", () => {
  it.each([true, false])("resolves hardware input and user rebinds with mac=%s", (isMac) => {
    const actions: string[] = [];
    const bindings = buildEffectiveBindings({ "command-center-toggle-cmd-k-mac": "Cmd+J" });
    const pipeline = createKeyboardPipeline({
      getContext: () => ({ isMac, usesDesktopBindings: true, commandCenterOpen: false }),
      getBindings: () => bindings,
      isCapturing: () => false,
      dispatch: (match) => {
        actions.push(match.action);
        return true;
      },
      overlays: createOverlayRegistry(),
    });
    pipeline.keyDown(nativeKeyboardInput(keyboardEvent("k", "KeyK", isMac), "message-input"));
    expect(actions).toEqual(isMac ? [] : ["command-center.toggle"]);
    pipeline.keyDown(nativeKeyboardInput(keyboardEvent("j", "KeyJ", isMac), "message-input"));
    expect(actions).toEqual(["command-center.toggle"]);
    pipeline.dispose();
  });
});

describe("overlay and focus precedence in the source pipeline", () => {
  it("dismisses an overlay without interrupting, then interrupts only the composer", () => {
    const registry = createOverlayRegistry();
    const actions: string[] = [];
    const pipeline = createKeyboardPipeline({
      getContext: () => ({ isMac: true, usesDesktopBindings: true, commandCenterOpen: false }),
      getBindings: () => buildEffectiveBindings({}),
      isCapturing: () => false,
      dispatch: (match) => {
        actions.push(match.action);
        return true;
      },
      overlays: registry,
    });
    let dismissals = 0;
    const remove = registry.register({
      getLayer: () => 20,
      getKeys: () => ["Escape"],
      onKeyDown: (event) => {
        if (event.key !== "Escape") return false;
        dismissals++;
        return true;
      },
    });
    const escape = { ...keyboardEvent("Escape", "Escape"), metaKey: false };
    pipeline.keyDown(nativeKeyboardInput(escape, "message-input"));
    expect(dismissals).toBe(1);
    expect(actions).toEqual([]);
    remove();
    pipeline.keyDown(nativeKeyboardInput(escape, "terminal"));
    expect(actions).toEqual([]);
    pipeline.keyDown(nativeKeyboardInput(escape, "message-input"));
    expect(actions).toEqual(["agent.interrupt"]);
    pipeline.dispose();
  });

  it("does not turn IME confirmation into overlay selection", () => {
    const registry = createOverlayRegistry();
    let selections = 0;
    const remove = registry.register({
      getLayer: () => 20,
      getKeys: () => ["Enter"],
      onKeyDown: () => {
        selections++;
        return true;
      },
    });
    const pipeline = createKeyboardPipeline({
      getContext: () => ({ isMac: true, usesDesktopBindings: true, commandCenterOpen: false }),
      getBindings: () => buildEffectiveBindings({}),
      isCapturing: () => false,
      dispatch: () => true,
      overlays: registry,
    });
    pipeline.keyDown(
      nativeKeyboardInput(
        { ...keyboardEvent("Enter", "Enter"), metaKey: false, isComposing: true },
        "message-input",
      ),
    );
    expect(selections).toBe(0);
    remove();
    pipeline.dispose();
  });

  it.each([true, false])(
    "uses hardware conventions for workspace index jumps with mac=%s",
    (isMac) => {
      const payloads: unknown[] = [];
      const pipeline = createKeyboardPipeline({
        getContext: () => ({ isMac, usesDesktopBindings: true, commandCenterOpen: false }),
        getBindings: () => buildEffectiveBindings({}),
        isCapturing: () => false,
        dispatch: (match) => {
          payloads.push([match.action, match.payload]);
          return true;
        },
        overlays: createOverlayRegistry(),
      });
      pipeline.keyDown(nativeKeyboardInput(keyboardEvent("3", "Digit3", isMac), "message-input"));
      expect(payloads).toEqual([["workspace.navigate.index", { index: 3 }]]);
      pipeline.dispose();
    },
  );
});

describe("hardware source adapter", () => {
  it.each([true, false])(
    "delivers hardware down/up and declared focus with mac=%s",
    async (isMac) => {
      const { attachHardwareKeyboardSource } = await import("./internal/sources/native");
      const { focusSurfaces } = await import("./internal/focus-surfaces");
      const actions: string[] = [];
      const releases: string[] = [];
      const events = new Set<
        (event: import("./internal/sources/hardware").HardwareKeyboardEvent) => void
      >();
      const releaseFocus = focusSurfaces.declare("message-input");
      const pipeline = createKeyboardPipeline({
        getContext: () => ({ isMac, usesDesktopBindings: true, commandCenterOpen: false }),
        getBindings: () => buildEffectiveBindings({}),
        isCapturing: () => false,
        dispatch: (match) => {
          actions.push(match.action);
          return true;
        },
        overlays: createOverlayRegistry(),
      });
      const detach = attachHardwareKeyboardSource(
        {
          subscribe(handler) {
            events.add(handler);
            return () => {
              events.delete(handler);
            };
          },
          setOverlayKeys() {},
        },
        {
          keyDown: pipeline.keyDown,
          keyUp: (event) => releases.push(event.key),
          blur() {},
          commandCenterOpen: () => false,
        },
      );
      const down = {
        ...keyboardEvent("k", "KeyK", isMac),
        isComposing: false,
        phase: "down" as const,
      };
      for (const listener of events) listener(down);
      for (const listener of events) listener({ ...down, phase: "up" });
      expect(actions).toEqual(["command-center.toggle"]);
      expect(releases).toEqual(["k"]);
      detach();
      releaseFocus();
      pipeline.dispose();
      expect(events.size).toBe(0);
    },
  );
});
