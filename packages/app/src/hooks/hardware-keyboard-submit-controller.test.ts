import { describe, expect, it } from "vitest";
import type {
  HardwareKeyboardSubmitChord,
  HardwareKeyboardSubmitKeys,
} from "@/native/android-hardware-keyboard-submit.types";
import {
  createHardwareKeyboardSubmitChordController,
  createHardwareKeyboardSubmitController,
  type HardwareKeyboardSubmitChordPort,
  type HardwareKeyboardSubmitListenerPort,
} from "./hardware-keyboard-submit-controller";

interface FakeKeyboard extends HardwareKeyboardSubmitListenerPort {
  emit(): void;
  readonly isEnabled: boolean;
  readonly listenerCount: number;
}

function createFakeKeyboard(): FakeKeyboard {
  const handlers = new Set<() => void>();
  let enabled = false;
  return {
    addListener(handler) {
      handlers.add(handler);
      return { remove: () => handlers.delete(handler) };
    },
    setEnabled(value) {
      enabled = value;
    },
    emit() {
      handlers.forEach((handler) => handler());
    },
    get isEnabled() {
      return enabled;
    },
    get listenerCount() {
      return handlers.size;
    },
  };
}

describe("hardware-keyboard-submit-controller", () => {
  it("dispatches to onSubmit when the keyboard emits while enabled", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    let calls = 0;
    controller.setOnSubmit(() => {
      calls += 1;
    });

    controller.enable();
    keyboard.emit();

    expect(calls).toBe(1);
    expect(keyboard.isEnabled).toBe(true);
  });

  it("does not subscribe or enable when never enabled", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    let calls = 0;
    controller.setOnSubmit(() => {
      calls += 1;
    });

    keyboard.emit();

    expect(calls).toBe(0);
    expect(keyboard.listenerCount).toBe(0);
    expect(keyboard.isEnabled).toBe(false);
  });

  it("disables native hardware submit and unsubscribes on disable", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    controller.setOnSubmit(() => {});

    controller.enable();
    expect(keyboard.isEnabled).toBe(true);
    expect(keyboard.listenerCount).toBe(1);

    controller.disable();
    expect(keyboard.isEnabled).toBe(false);
    expect(keyboard.listenerCount).toBe(0);
  });

  it("dispatches the latest onSubmit handler", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    const received: string[] = [];
    controller.setOnSubmit(() => received.push("first"));

    controller.enable();
    controller.setOnSubmit(() => received.push("second"));
    keyboard.emit();

    expect(received).toEqual(["second"]);
  });

  it("does not dispatch after disable", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    let calls = 0;
    controller.setOnSubmit(() => {
      calls += 1;
    });

    controller.enable();
    controller.disable();
    keyboard.emit();

    expect(calls).toBe(0);
  });

  it("ignores repeated enable calls", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    let calls = 0;
    controller.setOnSubmit(() => {
      calls += 1;
    });

    controller.enable();
    controller.enable();
    keyboard.emit();

    expect(calls).toBe(1);
    expect(keyboard.listenerCount).toBe(1);
  });

  it("ignores disable without a prior enable", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);

    controller.disable();

    expect(keyboard.isEnabled).toBe(false);
  });
});

interface FakeChordKeyboard extends HardwareKeyboardSubmitChordPort {
  press(keys?: Partial<HardwareKeyboardSubmitKeys>): void;
  readonly chords: readonly HardwareKeyboardSubmitChord[];
  readonly publishCount: number;
  readonly listenerCount: number;
}

function createFakeChordKeyboard(): FakeChordKeyboard {
  const handlers = new Set<(keys: HardwareKeyboardSubmitKeys) => void>();
  let chords: readonly HardwareKeyboardSubmitChord[] = [];
  let publishCount = 0;
  return {
    addListener(handler) {
      handlers.add(handler);
      return { remove: () => handlers.delete(handler) };
    },
    setChords(next) {
      chords = next;
      publishCount += 1;
    },
    press(keys = {}) {
      const event = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...keys };
      handlers.forEach((handler) => handler(event));
    },
    get chords() {
      return chords;
    },
    get publishCount() {
      return publishCount;
    },
    get listenerCount() {
      return handlers.size;
    },
  };
}

describe("hardware-keyboard-submit chord controller", () => {
  it("publishes the chords and forwards the press with its modifiers", () => {
    const keyboard = createFakeChordKeyboard();
    const controller = createHardwareKeyboardSubmitChordController(keyboard);
    const presses: HardwareKeyboardSubmitKeys[] = [];
    controller.setOnSubmit((keys) => presses.push(keys));

    controller.setChords(["Control+Enter", "Meta+Enter"]);
    keyboard.press({ ctrlKey: true });

    expect(keyboard.chords).toEqual(["Control+Enter", "Meta+Enter"]);
    expect(presses).toEqual([{ shiftKey: false, ctrlKey: true, metaKey: false, altKey: false }]);
  });

  it("does not publish or subscribe while the composer has nothing to send", () => {
    const keyboard = createFakeChordKeyboard();
    const controller = createHardwareKeyboardSubmitChordController(keyboard);

    controller.setChords([]);

    expect(keyboard.publishCount).toBe(0);
    expect(keyboard.listenerCount).toBe(0);
  });

  it("releases Return and stops forwarding when the chords empty", () => {
    const keyboard = createFakeChordKeyboard();
    const controller = createHardwareKeyboardSubmitChordController(keyboard);
    let calls = 0;
    controller.setOnSubmit(() => {
      calls += 1;
    });

    controller.setChords(["Enter"]);
    controller.setChords([]);
    keyboard.press();

    expect(keyboard.chords).toEqual([]);
    expect(keyboard.listenerCount).toBe(0);
    expect(calls).toBe(0);
  });

  it("republishes only when the chords change", () => {
    const keyboard = createFakeChordKeyboard();
    const controller = createHardwareKeyboardSubmitChordController(keyboard);

    controller.setChords(["Enter", "Control+Enter"]);
    controller.setChords(["Enter", "Control+Enter"]);
    controller.setChords(["Control+Enter"]);

    expect(keyboard.publishCount).toBe(2);
    expect(keyboard.chords).toEqual(["Control+Enter"]);
    expect(keyboard.listenerCount).toBe(1);
  });

  it("uses the latest submit handler", () => {
    const keyboard = createFakeChordKeyboard();
    const controller = createHardwareKeyboardSubmitChordController(keyboard);
    const calls: string[] = [];
    controller.setOnSubmit(() => calls.push("first"));
    controller.setChords(["Enter"]);

    controller.setOnSubmit(() => calls.push("second"));
    keyboard.press();

    expect(calls).toEqual(["second"]);
  });
});
