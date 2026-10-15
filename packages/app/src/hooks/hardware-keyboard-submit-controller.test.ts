import { describe, expect, it } from "vitest";
import {
  createHardwareKeyboardSubmitController,
  type HardwareKeyboardEnterKeys,
  type HardwareKeyboardSubmitHandler,
  type HardwareKeyboardSubmitListenerPort,
} from "./hardware-keyboard-submit-controller";

const ENTER: HardwareKeyboardEnterKeys = { shiftKey: false, ctrlKey: false, metaKey: false };

interface FakeKeyboard extends HardwareKeyboardSubmitListenerPort {
  emit(keys?: HardwareKeyboardEnterKeys): void;
  readonly lastHandler: HardwareKeyboardSubmitHandler | null;
  readonly isEnabled: boolean;
  readonly listenerCount: number;
}

function createFakeKeyboard(): FakeKeyboard {
  const handlers = new Set<HardwareKeyboardSubmitHandler>();
  let enabled = false;
  let lastHandler: HardwareKeyboardSubmitHandler | null = null;
  return {
    addListener(handler) {
      handlers.add(handler);
      lastHandler = handler;
      return { remove: () => handlers.delete(handler) };
    },
    setEnabled(value) {
      enabled = value;
    },
    emit(keys = ENTER) {
      handlers.forEach((handler) => handler(keys));
    },
    get isEnabled() {
      return enabled;
    },
    get lastHandler() {
      return lastHandler;
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

  it("passes the native Enter modifiers to onSubmit", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    const received: HardwareKeyboardEnterKeys[] = [];
    controller.setOnSubmit((keys) => received.push(keys));

    controller.enable();
    keyboard.emit({ shiftKey: false, ctrlKey: true, metaKey: false });

    expect(received).toEqual([{ shiftKey: false, ctrlKey: true, metaKey: false }]);
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

  it("does not dispatch a native event that arrives after disable", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    let calls = 0;
    controller.setOnSubmit(() => {
      calls += 1;
    });

    controller.enable();
    const lateHandler = keyboard.lastHandler;
    controller.disable();
    lateHandler?.(ENTER);

    expect(lateHandler).not.toBeNull();
    expect(calls).toBe(0);
  });

  it("does not dispatch a late event from an earlier enable after re-enabling", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    let calls = 0;
    controller.setOnSubmit(() => {
      calls += 1;
    });

    controller.enable();
    const staleHandler = keyboard.lastHandler;
    controller.disable();
    controller.enable();
    staleHandler?.(ENTER);
    expect(calls).toBe(0);

    keyboard.emit();
    expect(calls).toBe(1);
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
