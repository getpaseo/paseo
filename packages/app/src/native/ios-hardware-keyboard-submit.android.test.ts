import { beforeEach, describe, expect, it, vi } from "vitest";

interface SubmitEvent {
  targetNativeId: string;
  ctrlKey: boolean;
  metaKey: boolean;
}

type SubmitEventHandler = (event: SubmitEvent) => void;

const nativeModule = vi.hoisted(() => {
  const handlers = new Set<SubmitEventHandler>();
  return {
    handlers,
    setHardwareKeyboardSubmitEnabled: vi.fn(),
    addListener(_eventName: string, handler: SubmitEventHandler) {
      handlers.add(handler);
      return { remove: () => handlers.delete(handler) };
    },
    emit(targetNativeId: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
      const event = { targetNativeId, ctrlKey: false, metaKey: false, ...modifiers };
      handlers.forEach((handler) => handler(event));
    },
  };
});

vi.mock("expo-modules-core", () => ({
  requireNativeModule: () => nativeModule,
}));

const { addHardwareKeyboardSubmitListener, setHardwareKeyboardSubmitEnabled } =
  await import("./ios-hardware-keyboard-submit.android");

describe("Android hardware keyboard submit adapter", () => {
  beforeEach(() => {
    nativeModule.handlers.clear();
    nativeModule.setHardwareKeyboardSubmitEnabled.mockClear();
  });

  it("delivers a native submit only to the composer whose view native matched", () => {
    const received: string[] = [];
    addHardwareKeyboardSubmitListener(() => received.push("first"), "composer-first");
    addHardwareKeyboardSubmitListener(() => received.push("second"), "composer-second");

    nativeModule.emit("composer-second");

    expect(received).toEqual(["second"]);
  });

  it("delivers the Enter modifiers that native read from the initial key press", () => {
    const received: unknown[] = [];
    addHardwareKeyboardSubmitListener((keys) => received.push(keys), "composer-first");

    nativeModule.emit("composer-first", { metaKey: true });

    expect(received).toEqual([{ shiftKey: false, ctrlKey: false, metaKey: true }]);
  });

  it("stops delivering after the subscription is removed", () => {
    const received: string[] = [];
    const subscription = addHardwareKeyboardSubmitListener(
      () => received.push("first"),
      "composer-first",
    );

    subscription.remove();
    nativeModule.emit("composer-first");

    expect(received).toEqual([]);
  });

  it("registers and releases the composer's view with native", () => {
    setHardwareKeyboardSubmitEnabled(true, "composer-first");
    setHardwareKeyboardSubmitEnabled(false, "composer-first");

    expect(nativeModule.setHardwareKeyboardSubmitEnabled.mock.calls).toEqual([
      [true, "composer-first"],
      [false, "composer-first"],
    ]);
  });
});
