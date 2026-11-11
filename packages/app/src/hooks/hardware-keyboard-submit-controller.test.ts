import { describe, expect, it } from "vitest";
import type {
  HardwareKeyboardSendShortcut,
  HardwareKeyboardSubmitEvent,
} from "@/native/hardware-keyboard-submit.types";
import {
  createHardwareKeyboardSubmitController,
  type HardwareKeyboardSubmitListenerPort,
} from "./hardware-keyboard-submit-controller";

const submitEvent: HardwareKeyboardSubmitEvent = {
  shiftKey: false,
  ctrlKey: true,
  metaKey: false,
  altKey: false,
};

interface FakeKeyboard extends HardwareKeyboardSubmitListenerPort {
  emit(event: HardwareKeyboardSubmitEvent): void;
  readonly isEnabled: boolean;
  readonly sendShortcut: HardwareKeyboardSendShortcut | null;
  readonly listenerCount: number;
}

function createFakeKeyboard(): FakeKeyboard {
  const handlers = new Set<(event: HardwareKeyboardSubmitEvent) => void>();
  let enabled = false;
  let sendShortcut: HardwareKeyboardSendShortcut | null = null;
  return {
    addListener(handler) {
      handlers.add(handler);
      return { remove: () => handlers.delete(handler) };
    },
    setEnabled(value, nextSendShortcut) {
      enabled = value;
      sendShortcut = value ? nextSendShortcut : null;
    },
    emit(event) {
      handlers.forEach((handler) => handler(event));
    },
    get isEnabled() {
      return enabled;
    },
    get sendShortcut() {
      return sendShortcut;
    },
    get listenerCount() {
      return handlers.size;
    },
  };
}

describe("hardware-keyboard-submit-controller", () => {
  it("dispatches the event to onSubmit when the keyboard emits while enabled", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    const events: HardwareKeyboardSubmitEvent[] = [];
    controller.setOnSubmit((event) => {
      events.push(event);
    });

    controller.enable("enter");
    keyboard.emit(submitEvent);

    expect(events).toEqual([submitEvent]);
    expect(keyboard.isEnabled).toBe(true);
    expect(keyboard.sendShortcut).toBe("enter");
  });

  it("does not subscribe or enable when never enabled", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    let calls = 0;
    controller.setOnSubmit(() => {
      calls += 1;
    });

    keyboard.emit(submitEvent);

    expect(calls).toBe(0);
    expect(keyboard.listenerCount).toBe(0);
    expect(keyboard.isEnabled).toBe(false);
  });

  it("disables native hardware submit and unsubscribes on disable", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    controller.setOnSubmit(() => {});

    controller.enable("enter");
    expect(keyboard.isEnabled).toBe(true);
    expect(keyboard.sendShortcut).toBe("enter");
    expect(keyboard.listenerCount).toBe(1);

    controller.disable();
    expect(keyboard.isEnabled).toBe(false);
    expect(keyboard.sendShortcut).toBeNull();
    expect(keyboard.listenerCount).toBe(0);
  });

  it("passes a changed send shortcut to the native module while enabled", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    controller.setOnSubmit(() => {});

    controller.enable("enter");
    controller.enable("mod-enter");

    expect(keyboard.sendShortcut).toBe("mod-enter");
    expect(keyboard.listenerCount).toBe(1);
  });

  it("dispatches the latest onSubmit handler", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    const received: string[] = [];
    controller.setOnSubmit(() => received.push("first"));

    controller.enable("enter");
    controller.setOnSubmit(() => received.push("second"));
    keyboard.emit(submitEvent);

    expect(received).toEqual(["second"]);
  });

  it("does not dispatch after disable", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    let calls = 0;
    controller.setOnSubmit(() => {
      calls += 1;
    });

    controller.enable("enter");
    controller.disable();
    keyboard.emit(submitEvent);

    expect(calls).toBe(0);
  });

  it("ignores repeated enable calls", () => {
    const keyboard = createFakeKeyboard();
    const controller = createHardwareKeyboardSubmitController(keyboard);
    let calls = 0;
    controller.setOnSubmit(() => {
      calls += 1;
    });

    controller.enable("enter");
    controller.enable("enter");
    keyboard.emit(submitEvent);

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
