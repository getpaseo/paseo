import { describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(() => {
  const handlers = new Set<() => void>();
  return {
    handlers,
    setHardwareKeyboardSubmitEnabled: vi.fn(),
    addListener(_eventName: string, handler: () => void) {
      handlers.add(handler);
      return { remove: () => handlers.delete(handler) };
    },
    emit() {
      handlers.forEach((handler) => handler());
    },
  };
});

vi.mock("expo-modules-core", () => ({
  requireNativeModule: () => nativeModule,
}));

const {
  addHardwareKeyboardSubmitListener,
  hardwareKeyboardEnterRules,
  setHardwareKeyboardSubmitEnabled,
} = await import("./ios-hardware-keyboard-submit.ios");

describe("iOS hardware keyboard submit adapter", () => {
  it("reports the iPad Enter key command as an unmodified Enter under send-button rules", () => {
    const received: unknown[] = [];
    addHardwareKeyboardSubmitListener((keys) => received.push(keys), null);

    nativeModule.emit();

    expect(received).toEqual([{ shiftKey: false, ctrlKey: false, metaKey: false }]);
    expect(hardwareKeyboardEnterRules).toBe("send-button");
  });

  it("keeps the single-argument native enable call", () => {
    setHardwareKeyboardSubmitEnabled(true, null);
    expect(nativeModule.setHardwareKeyboardSubmitEnabled.mock.calls).toEqual([[true]]);
  });
});
