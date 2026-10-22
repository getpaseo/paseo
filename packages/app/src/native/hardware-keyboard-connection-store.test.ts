import { describe, expect, it } from "vitest";
import {
  createHardwareKeyboardConnectionStore,
  type HardwareKeyboardConnectionPort,
} from "./hardware-keyboard-connection-store";

interface FakeHardwareKeyboard extends HardwareKeyboardConnectionPort {
  emit(connected: boolean): void;
}

function createFakeHardwareKeyboard(initiallyConnected: boolean): FakeHardwareKeyboard {
  const handlers = new Set<(connected: boolean) => void>();
  return {
    isConnected() {
      return initiallyConnected;
    },
    addListener(handler) {
      handlers.add(handler);
    },
    emit(connected) {
      handlers.forEach((handler) => handler(connected));
    },
  };
}

describe("hardware-keyboard-connection-store", () => {
  it("starts disconnected when the keyboard reports no connection", () => {
    const store = createHardwareKeyboardConnectionStore(createFakeHardwareKeyboard(false));

    expect(store.getSnapshot()).toBe(false);
  });

  it("notifies the subscriber once and updates the snapshot when a connection is emitted", () => {
    const keyboard = createFakeHardwareKeyboard(false);
    const store = createHardwareKeyboardConnectionStore(keyboard);
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });

    keyboard.emit(true);

    expect(calls).toBe(1);
    expect(store.getSnapshot()).toBe(true);
  });

  it("stops notifying a subscriber after unsubscribe", () => {
    const keyboard = createFakeHardwareKeyboard(false);
    const store = createHardwareKeyboardConnectionStore(keyboard);
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    keyboard.emit(true);

    unsubscribe();
    keyboard.emit(false);

    expect(calls).toBe(1);
  });

  it("reports connected from the initial read when no event is emitted", () => {
    const store = createHardwareKeyboardConnectionStore(createFakeHardwareKeyboard(true));

    expect(store.getSnapshot()).toBe(true);
  });
});
