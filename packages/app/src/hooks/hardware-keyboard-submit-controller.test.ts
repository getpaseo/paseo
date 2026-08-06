import { describe, expect, it } from "vitest";
import {
  createHardwareKeyboardSubmitController,
  type HardwareKeyboardSubmitListenerPort,
} from "./hardware-keyboard-submit-controller";
import type { HardwareKeyboardSubmitEvent } from "@/native/hardware-keyboard-submit.types";

type FakeHandler = (event: HardwareKeyboardSubmitEvent) => void;

interface FakeKeyboard extends HardwareKeyboardSubmitListenerPort {
  emit(event?: HardwareKeyboardSubmitEvent): void;
  readonly isEnabled: boolean;
  readonly listenerCount: number;
}

function createFakeKeyboard(): FakeKeyboard {
  const handlers = new Set<FakeHandler>();
  let enabled = false;
  return {
    addListener(handler) {
      handlers.add(handler);
      return { remove: () => handlers.delete(handler) };
    },
    setEnabled(value) {
      enabled = value;
    },
    emit(event = { alternate: false }) {
      handlers.forEach((handler) => handler(event));
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

  it("forwards the alternate flag from the emitted event", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    const received: boolean[] = [];
    controller.setOnSubmit((event) => received.push(event.alternate));

    controller.enable();
    keyboard.emit({ alternate: true });
    keyboard.emit({ alternate: false });

    expect(received).toEqual([true, false]);
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
