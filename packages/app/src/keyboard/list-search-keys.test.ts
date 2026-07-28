import { describe, expect, it } from "vitest";
import { resolveListSearchKeyAction } from "./list-search-keys";

describe("resolveListSearchKeyAction", () => {
  it("maps Emacs-style Ctrl+N / Ctrl+P onto list movement", () => {
    expect(resolveListSearchKeyAction({ key: "n", ctrlKey: true })).toBe("next");
    expect(resolveListSearchKeyAction({ key: "p", ctrlKey: true })).toBe("previous");
  });

  it("accepts Ctrl+N with caps lock on", () => {
    expect(resolveListSearchKeyAction({ key: "N", ctrlKey: true })).toBe("next");
  });

  it("maps the arrow keys and Enter", () => {
    expect(resolveListSearchKeyAction({ key: "ArrowDown" })).toBe("next");
    expect(resolveListSearchKeyAction({ key: "ArrowUp" })).toBe("previous");
    expect(resolveListSearchKeyAction({ key: "Enter" })).toBe("submit");
  });

  it("ignores plain typing", () => {
    expect(resolveListSearchKeyAction({ key: "n" })).toBeNull();
    expect(resolveListSearchKeyAction({ key: "p" })).toBeNull();
    expect(resolveListSearchKeyAction({ key: "a", ctrlKey: true })).toBeNull();
  });

  it("leaves combos carrying another modifier to the global shortcuts", () => {
    expect(resolveListSearchKeyAction({ key: "n", ctrlKey: true, shiftKey: true })).toBeNull();
    expect(resolveListSearchKeyAction({ key: "n", ctrlKey: true, metaKey: true })).toBeNull();
    expect(resolveListSearchKeyAction({ key: "p", ctrlKey: true, altKey: true })).toBeNull();
    expect(resolveListSearchKeyAction({ key: "Enter", shiftKey: true })).toBeNull();
  });
});
