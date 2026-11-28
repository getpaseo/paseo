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
      const { createHardwareKeyboardSource } = await import("./internal/sources/native");
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
      const detach = createHardwareKeyboardSource({
        subscribe(handler) {
          events.add(handler);
          return () => {
            events.delete(handler);
          };
        },
        setOverlayKeys() {},
        setClaimedShortcuts() {},
      }).attach({
        keyDown: pipeline.keyDown,
        keyUp: (event) => releases.push(event.key),
        blur() {},
        commandCenterOpen: () => false,
        subscribeCommandCenter: () => () => {},
      });
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

  it("claims the Shift and Option shortcuts a focused text control would otherwise type", async () => {
    const { createHardwareKeyboardSource } = await import("./internal/sources/native");
    const { focusSurfaces } = await import("./internal/focus-surfaces");
    let claimed: string[] = [];
    const source = createHardwareKeyboardSource({
      subscribe: () => () => {},
      setOverlayKeys() {},
      setClaimedShortcuts(shortcuts) {
        claimed = shortcuts
          .map(({ code, shift, alt }) => [alt && "Alt", shift && "Shift", code])
          .map((parts) => parts.filter(Boolean).join("+"))
          .sort();
      },
    });
    source.publishPolicy({
      bindings: buildEffectiveBindings({}),
      isMac: true,
      usesDesktopBindings: true,
      enabled: true,
    });
    let commandCenterOpen = false;
    const commandCenterListeners = new Set<() => void>();
    const detach = source.attach({
      keyDown() {},
      keyUp() {},
      blur() {},
      commandCenterOpen: () => commandCenterOpen,
      subscribeCommandCenter(listener) {
        commandCenterListeners.add(listener);
        return () => commandCenterListeners.delete(listener);
      },
    });
    const setCommandCenterOpen = (open: boolean) => {
      commandCenterOpen = open;
      for (const listener of commandCenterListeners) listener();
    };
    // iPad tab switching uses Cmd+Shift+[ / ], which no text control types.
    expect(claimed).toEqual([]);

    const releaseComposer = focusSurfaces.declare("message-input");
    expect(claimed).toEqual(["Shift+Tab"]);
    setCommandCenterOpen(true);
    expect(claimed).toEqual([]);
    setCommandCenterOpen(false);
    expect(claimed).toEqual(["Shift+Tab"]);
    releaseComposer();
    expect(claimed).toEqual([]);

    source.publishPolicy({
      bindings: buildEffectiveBindings({ "message-input-mode-cycle-shift-tab": "Alt+M" }),
      isMac: true,
      usesDesktopBindings: true,
      enabled: true,
    });
    const releaseRebound = focusSurfaces.declare("message-input");
    expect(claimed).toEqual(["Alt+KeyM"]);
    releaseRebound();

    // A chord's later step is only a shortcut while the chord is in progress;
    // claiming it always would stop the composer typing a capital A.
    source.publishPolicy({
      bindings: buildEffectiveBindings({ "message-input-mode-cycle-shift-tab": "Mod+J Shift+A" }),
      isMac: true,
      usesDesktopBindings: true,
      enabled: true,
    });
    const releaseChord = focusSurfaces.declare("message-input");
    expect(claimed).toEqual([]);
    releaseChord();

    const releaseFinal = focusSurfaces.declare("message-input");
    source.publishPolicy({
      bindings: buildEffectiveBindings({}),
      isMac: true,
      usesDesktopBindings: true,
      enabled: false,
    });
    expect(claimed).toEqual([]);
    source.publishPolicy({
      bindings: buildEffectiveBindings({}),
      isMac: true,
      usesDesktopBindings: true,
      enabled: true,
    });
    expect(claimed).toEqual(["Shift+Tab"]);
    detach();
    expect(claimed).toEqual([]);
    releaseFinal();
  });

  it("forwards native blur events and unsubscribes on detach", async () => {
    const { createHardwareKeyboardSource } = await import("./internal/sources/native");
    const blurListeners = new Set<() => void>();
    let blurCalls = 0;
    const detach = createHardwareKeyboardSource({
      subscribe: () => () => {},
      subscribeBlur(listener) {
        blurListeners.add(listener);
        return () => {
          blurListeners.delete(listener);
        };
      },
      setOverlayKeys() {},
      setClaimedShortcuts() {},
    }).attach({
      keyDown() {},
      keyUp() {},
      blur() {
        blurCalls += 1;
      },
      commandCenterOpen: () => false,
      subscribeCommandCenter: () => () => {},
    });
    for (const listener of blurListeners) listener();
    expect(blurCalls).toBe(1);
    detach();
    expect(blurListeners.size).toBe(0);
  });
});

function modifierKey(
  key: string,
  code: string,
  flags: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {},
) {
  return { key, code, shiftKey: false, metaKey: false, ctrlKey: false, ...flags };
}

describe("held modifier tracking", () => {
  it("tracks left/right Shift holds, self-heals on non-shifted keys, and resets on blur", async () => {
    const { createHeldModifierTracker } = await import("./internal/press-modifiers");
    const tracker = createHeldModifierTracker();
    expect(tracker.isDown("Shift")).toBe(false);

    tracker.handleKeyDown(modifierKey("Shift", "ShiftLeft", { shiftKey: true }));
    expect(tracker.isDown("Shift")).toBe(true);

    tracker.handleKeyDown(modifierKey("Shift", "ShiftRight", { shiftKey: true }));
    tracker.handleKeyUp(modifierKey("Shift", "ShiftLeft", { shiftKey: true }));
    expect(tracker.isDown("Shift")).toBe(true);

    tracker.handleKeyUp(modifierKey("Shift", "ShiftRight"));
    expect(tracker.isDown("Shift")).toBe(false);

    // Self-heals if a Shift key-up was swallowed by the OS.
    tracker.handleKeyDown(modifierKey("Shift", "ShiftLeft", { shiftKey: true }));
    expect(tracker.isDown("Shift")).toBe(true);
    tracker.handleKeyDown(modifierKey("a", "KeyA"));
    expect(tracker.isDown("Shift")).toBe(false);

    // Clears on blur / backgrounding.
    tracker.handleKeyDown(modifierKey("Shift", "ShiftLeft", { shiftKey: true }));
    expect(tracker.isDown("Shift")).toBe(true);
    tracker.reset();
    expect(tracker.isDown("Shift")).toBe(false);
  });

  it("tracks Cmd and Ctrl holds independently of Shift", async () => {
    const { createHeldModifierTracker } = await import("./internal/press-modifiers");
    const tracker = createHeldModifierTracker();

    tracker.handleKeyDown(modifierKey("Meta", "MetaLeft", { metaKey: true }));
    tracker.handleKeyDown(modifierKey("Shift", "ShiftLeft", { metaKey: true, shiftKey: true }));
    expect([tracker.isDown("Meta"), tracker.isDown("Shift"), tracker.isDown("Control")]).toEqual([
      true,
      true,
      false,
    ]);

    tracker.handleKeyUp(modifierKey("Shift", "ShiftLeft", { metaKey: true }));
    expect([tracker.isDown("Meta"), tracker.isDown("Shift")]).toEqual([true, false]);

    // A key reported without the Meta flag means its key-up was swallowed.
    tracker.handleKeyDown(modifierKey("a", "KeyA"));
    expect(tracker.isDown("Meta")).toBe(false);

    tracker.handleKeyDown(modifierKey("Control", "ControlRight", { ctrlKey: true }));
    expect(tracker.isDown("Control")).toBe(true);
    tracker.handleKeyUp(modifierKey("Control", "ControlRight"));
    expect(tracker.isDown("Control")).toBe(false);
  });
});

describe("press modifiers", () => {
  it("reads Shift and the platform primary modifier from a pointer press", async () => {
    const { createHeldModifierTracker, readPressModifiers } =
      await import("./internal/press-modifiers");
    const held = createHeldModifierTracker();
    const mac = { isMac: true, held };
    const other = { isMac: false, held };

    expect(readPressModifiers({ shiftKey: true }, mac)).toEqual({ shift: true, mod: false });
    expect(readPressModifiers({ nativeEvent: { shiftKey: true } }, other)).toEqual({
      shift: true,
      mod: false,
    });
    expect(readPressModifiers({ metaKey: true }, mac)).toEqual({ shift: false, mod: true });
    expect(readPressModifiers({ ctrlKey: true }, other)).toEqual({ shift: false, mod: true });
    // Ctrl+click is the secondary click on macOS, and Windows/Linux have no Cmd.
    expect(readPressModifiers({ ctrlKey: true }, mac)).toEqual({ shift: false, mod: false });
    expect(readPressModifiers({ metaKey: true }, other)).toEqual({ shift: false, mod: false });
    expect(readPressModifiers(null, mac)).toEqual({ shift: false, mod: false });
  });

  it("falls back to held hardware keys when a native press omits modifiers", async () => {
    const { createHeldModifierTracker, readPressModifiers } =
      await import("./internal/press-modifiers");
    const held = createHeldModifierTracker();
    const responderEvent = { nativeEvent: { locationX: 12, locationY: 8 } };

    held.handleKeyDown(modifierKey("Meta", "MetaLeft", { metaKey: true }));
    expect(readPressModifiers(responderEvent, { isMac: true, held })).toEqual({
      shift: false,
      mod: true,
    });
    expect(readPressModifiers(responderEvent, { isMac: false, held })).toEqual({
      shift: false,
      mod: false,
    });

    held.reset();
    held.handleKeyDown(modifierKey("Shift", "ShiftLeft", { shiftKey: true }));
    expect(readPressModifiers(responderEvent, { isMac: true, held })).toEqual({
      shift: true,
      mod: false,
    });
  });
});

describe("non-TextInput native focus registration", () => {
  it("reports focused native text editors and keeps terminal shortcuts blocked until released", async () => {
    const { hasRegisteredFocusedTextInput, registerFocusedTextInput } =
      await import("./internal/native-focused-input");
    const { createKeyboardFocusScope } = await import("./internal/focus-surfaces");

    expect(hasRegisteredFocusedTextInput()).toBe(false);
    const scope = createKeyboardFocusScope(hasRegisteredFocusedTextInput);
    expect(scope.resolve(false)).toBe("other");

    const releaseFirst = registerFocusedTextInput();
    expect(hasRegisteredFocusedTextInput()).toBe(true);
    expect(scope.resolve(false)).toBe("editable");

    // Overlapping focus from a second terminal must survive the first terminal blurring.
    const releaseSecond = registerFocusedTextInput();
    releaseFirst();
    expect(hasRegisteredFocusedTextInput()).toBe(true);

    // Declaring the terminal focus surface narrows the scope to "terminal".
    const releaseSurface = scope.declare("terminal");
    expect(scope.resolve(false)).toBe("terminal");

    releaseSurface();
    releaseSecond();
    expect(hasRegisteredFocusedTextInput()).toBe(false);
    expect(scope.resolve(false)).toBe("other");
  });
});
