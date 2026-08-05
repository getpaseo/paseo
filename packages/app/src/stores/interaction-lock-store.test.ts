import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

import { useInteractionLockStore } from "./interaction-lock-store";

describe("interaction lock store", () => {
  beforeEach(() => {
    useInteractionLockStore.setState({ locked: false });
  });

  it("defaults unlocked", () => {
    expect(useInteractionLockStore.getState().locked).toBe(false);
  });

  it("toggles lock", () => {
    useInteractionLockStore.getState().setLocked(true);
    expect(useInteractionLockStore.getState().locked).toBe(true);
    useInteractionLockStore.getState().toggle();
    expect(useInteractionLockStore.getState().locked).toBe(false);
  });

  it("setLocked is idempotent", () => {
    useInteractionLockStore.getState().setLocked(true);
    useInteractionLockStore.getState().setLocked(true);
    expect(useInteractionLockStore.getState().locked).toBe(true);
  });
});
