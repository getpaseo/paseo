import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateForInteractionUnlock = vi.fn();

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("./auth", () => ({
  authenticateForInteractionUnlock: (...args: unknown[]) =>
    authenticateForInteractionUnlock(...args),
}));

import { useInteractionLockStore } from "@/stores/interaction-lock-store";
import {
  isInteractionNavigationAllowed,
  lockInteractionScreen,
  unlockInteractionScreen,
} from "./actions";

describe("interaction lock actions", () => {
  beforeEach(() => {
    useInteractionLockStore.setState({ locked: false });
    authenticateForInteractionUnlock.mockReset();
  });

  it("locks without auth", () => {
    lockInteractionScreen();
    expect(useInteractionLockStore.getState().locked).toBe(true);
    expect(isInteractionNavigationAllowed()).toBe(false);
  });

  it("requires auth on android before unlock", async () => {
    lockInteractionScreen();
    authenticateForInteractionUnlock.mockResolvedValue({ ok: true });
    await expect(unlockInteractionScreen({ promptMessage: "Unlock Paseo" })).resolves.toEqual({
      status: "unlocked",
    });
    expect(authenticateForInteractionUnlock).toHaveBeenCalled();
    expect(useInteractionLockStore.getState().locked).toBe(false);
  });

  it("stays locked when auth is cancelled", async () => {
    lockInteractionScreen();
    authenticateForInteractionUnlock.mockResolvedValue({
      ok: false,
      reason: "cancelled",
    });
    await expect(unlockInteractionScreen({ promptMessage: "Unlock Paseo" })).resolves.toEqual({
      status: "cancelled",
    });
    expect(useInteractionLockStore.getState().locked).toBe(true);
  });
});
