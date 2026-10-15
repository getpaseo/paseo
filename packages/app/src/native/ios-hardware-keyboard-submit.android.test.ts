import { beforeEach, describe, expect, it, vi } from "vitest";

const { listeners } = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
vi.mock("react-native", () => ({
  DeviceEventEmitter: {
    addListener: (_name: string, handler: () => void) => {
      listeners.add(handler);
      return { remove: () => listeners.delete(handler) };
    },
  },
}));

import {
  addHardwareKeyboardSubmitListener,
  setHardwareKeyboardSubmitEnabled,
} from "./ios-hardware-keyboard-submit.android";

describe("Android hardware keyboard submit bridge", () => {
  beforeEach(() => {
    listeners.clear();
    setHardwareKeyboardSubmitEnabled(false);
  });

  it("only sends while the focused composer enables submission", () => {
    const submit = vi.fn();
    addHardwareKeyboardSubmitListener(submit);
    listeners.forEach((listener) => listener());
    expect(submit).not.toHaveBeenCalled();
    setHardwareKeyboardSubmitEnabled(true);
    listeners.forEach((listener) => listener());
    expect(submit).toHaveBeenCalledTimes(1);
    setHardwareKeyboardSubmitEnabled(false);
    listeners.forEach((listener) => listener());
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("removes the event listener on cleanup", () => {
    const submit = vi.fn();
    const subscription = addHardwareKeyboardSubmitListener(submit);
    setHardwareKeyboardSubmitEnabled(true);
    subscription.remove();
    listeners.forEach((listener) => listener());
    expect(submit).not.toHaveBeenCalled();
  });
});
