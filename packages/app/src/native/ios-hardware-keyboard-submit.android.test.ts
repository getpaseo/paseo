import { describe, expect, it } from "vitest";
import {
  createHardwareKeyboardSubmitBridge,
  type HardwareKeyboardEvents,
} from "./android-hardware-keyboard-bridge";

class InMemoryKeyboardEvents implements HardwareKeyboardEvents {
  private listeners = new Map<string, Set<() => void>>();

  addListener(name: string, handler: () => void) {
    const handlers = this.listeners.get(name) ?? new Set<() => void>();
    this.listeners.set(name, handlers);
    handlers.add(handler);
    return {
      remove: () => {
        handlers.delete(handler);
      },
    };
  }

  emit(name = "paseoHardwareKeyboardSubmit") {
    this.listeners.get(name)?.forEach((handler) => handler());
  }
}

describe("Android hardware keyboard submit bridge", () => {
  it("only sends while the focused composer enables submission", () => {
    const events = new InMemoryKeyboardEvents();
    const bridge = createHardwareKeyboardSubmitBridge(events);
    const sent: string[] = [];
    bridge.addHardwareKeyboardSubmitListener(() => sent.push("submit"));
    events.emit();
    expect(sent).toEqual([]);
    bridge.setHardwareKeyboardSubmitEnabled(true);
    events.emit("unrelated");
    expect(sent).toEqual([]);
    events.emit();
    expect(sent).toEqual(["submit"]);
    bridge.setHardwareKeyboardSubmitEnabled(false);
    events.emit();
    expect(sent).toEqual(["submit"]);
  });

  it("removes only the requested subscription on cleanup", () => {
    const events = new InMemoryKeyboardEvents();
    const bridge = createHardwareKeyboardSubmitBridge(events);
    const sent: string[] = [];
    const subscription = bridge.addHardwareKeyboardSubmitListener(() => sent.push("removed"));
    bridge.addHardwareKeyboardSubmitListener(() => sent.push("active"));
    bridge.setHardwareKeyboardSubmitEnabled(true);
    subscription.remove();
    subscription.remove();
    events.emit();
    expect(sent).toEqual(["active"]);
  });
});
