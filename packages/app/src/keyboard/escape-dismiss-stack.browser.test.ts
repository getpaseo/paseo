import { afterEach, describe, expect, it, vi } from "vitest";
import { hasEscapeDismissHandler, pushEscapeDismissHandler } from "./escape-dismiss-stack";
import { resolveKeyboardShortcut, type ChordState } from "./keyboard-shortcuts";

// This proves the actual bug end-to-end in a real browser: two window capture
// listeners (the global dispatcher + the overlay's escape stack) plus shared
// state. The unit tests can only cover the pure pieces — in Node `window` is
// undefined, so the stack never attaches its listener and the integration the
// bug lives in goes unexercised.

// Mimic the global dispatcher's keydown listener (use-keyboard-shortcuts.ts):
// a window capture listener that resolves shortcuts with overlayOpen fed from
// the shared stack. It records whether agent.interrupt WOULD have fired.
function installDispatcherProbe() {
  const interrupts: string[] = [];
  const chordState: ChordState = { candidateIndices: [], step: 0, timeoutId: null };
  const listener = (event: KeyboardEvent) => {
    const result = resolveKeyboardShortcut({
      event,
      context: {
        isMac: false,
        isDesktop: true,
        // Escape interrupts even from the message input — the gate must be the
        // open overlay, not the focus scope.
        focusScope: "message-input",
        commandCenterOpen: false,
        overlayOpen: hasEscapeDismissHandler(),
      },
      chordState,
      onChordReset: () => {},
    });
    if (result.match?.action === "agent.interrupt") {
      interrupts.push(result.match.action);
    }
  };
  // Register BEFORE any overlay opens — the dispatcher mounts at app start, which
  // is the exact ordering that made the modal's stopPropagation insufficient.
  window.addEventListener("keydown", listener, true);
  return { interrupts, dispose: () => window.removeEventListener("keydown", listener, true) };
}

function pressEscape(): KeyboardEvent {
  // Real Escape keydown carries both key and code; the binding matches on code.
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

describe("escape-dismiss-stack integration (browser)", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it("closes the overlay and does NOT interrupt the agent when Escape is pressed with a dialog open", () => {
    const probe = installDispatcherProbe();
    cleanups.push(probe.dispose);

    const close = vi.fn();
    cleanups.push(pushEscapeDismissHandler(close));

    const event = pressEscape();

    expect(close).toHaveBeenCalledTimes(1); // shared stack closed the overlay
    expect(probe.interrupts).toEqual([]); // dispatcher suppressed agent.interrupt
    expect(event.defaultPrevented).toBe(true); // stack listener claimed the key
  });

  it("interrupts the agent on Escape once the overlay is gone", () => {
    const probe = installDispatcherProbe();
    cleanups.push(probe.dispose);

    const close = vi.fn();
    const disposeHandler = pushEscapeDismissHandler(close);
    disposeHandler(); // overlay closed / unmounted

    pressEscape();

    expect(close).not.toHaveBeenCalled();
    expect(probe.interrupts).toEqual(["agent.interrupt"]);
  });

  it("routes Escape to the topmost overlay only (nested dialogs)", () => {
    const probe = installDispatcherProbe();
    cleanups.push(probe.dispose);

    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    cleanups.push(pushEscapeDismissHandler(closeOuter));
    const disposeInner = pushEscapeDismissHandler(closeInner);

    pressEscape();
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
    expect(probe.interrupts).toEqual([]);

    disposeInner(); // inner dialog closed; outer is now topmost
    pressEscape();
    expect(closeOuter).toHaveBeenCalledTimes(1);
    expect(probe.interrupts).toEqual([]);
  });
});
