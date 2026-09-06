import { describe, expect, it } from "vitest";
import { resolveListSearchKeyAction } from "./list-search-keys";

describe("resolveListSearchKeyAction", () => {
  it("maps Ctrl+N and Ctrl+P case-insensitively", () => {
    expect(resolveListSearchKeyAction({ key: "n", ctrlKey: true })).toBe("next");
    expect(resolveListSearchKeyAction({ key: "N", ctrlKey: true })).toBe("next");
    expect(resolveListSearchKeyAction({ key: "p", ctrlKey: true })).toBe("previous");
    expect(resolveListSearchKeyAction({ key: "P", ctrlKey: true })).toBe("previous");
  });

  it("maps arrows and Enter", () => {
    expect(resolveListSearchKeyAction({ key: "ArrowDown" })).toBe("next");
    expect(resolveListSearchKeyAction({ key: "ArrowUp" })).toBe("previous");
    expect(resolveListSearchKeyAction({ key: "Enter" })).toBe("submit");
  });

  it("leaves typing and other modified chords alone", () => {
    expect(resolveListSearchKeyAction({ key: "n" })).toBeNull();
    expect(resolveListSearchKeyAction({ key: "p" })).toBeNull();
    expect(resolveListSearchKeyAction({ key: "n", ctrlKey: true, shiftKey: true })).toBeNull();
    expect(resolveListSearchKeyAction({ key: "p", ctrlKey: true, altKey: true })).toBeNull();
    expect(resolveListSearchKeyAction({ key: "n", ctrlKey: true, metaKey: true })).toBeNull();
  });
});
