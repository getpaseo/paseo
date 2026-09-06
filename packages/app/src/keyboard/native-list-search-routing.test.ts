import { describe, expect, it, vi } from "vitest";
import { routeNativeListSearchBeforeShortcut } from "./native-list-search-routing";

const ctrlN = {
  code: "KeyN",
  metaKey: false,
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
};

describe("routeNativeListSearchBeforeShortcut", () => {
  it("stops after a list handles the hardware key", () => {
    const dispatchList = vi.fn(() => true);
    const dispatchShortcut = vi.fn();

    expect(
      routeNativeListSearchBeforeShortcut({ event: ctrlN, dispatchList, dispatchShortcut }),
    ).toBe(true);
    expect(dispatchList).toHaveBeenCalledWith(
      expect.objectContaining({ key: "n", code: "KeyN", ctrlKey: true }),
    );
    expect(dispatchShortcut).not.toHaveBeenCalled();
  });

  it("continues to global shortcut resolution when no list handles the key", () => {
    const dispatchShortcut = vi.fn();

    expect(
      routeNativeListSearchBeforeShortcut({
        event: { ...ctrlN, code: "KeyK", ctrlKey: false, metaKey: true },
        dispatchList: () => false,
        dispatchShortcut,
      }),
    ).toBe(false);
    expect(dispatchShortcut).toHaveBeenCalledWith(
      expect.objectContaining({ key: "k", code: "KeyK", metaKey: true }),
    );
  });
});
