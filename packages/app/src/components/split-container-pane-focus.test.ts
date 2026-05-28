import { describe, expect, it } from "vitest";
import { shouldFocusPaneFromEventTarget } from "@/components/split-container-pane-focus";

describe("shouldFocusPaneFromEventTarget", () => {
  it("returns false for links and buttons", () => {
    expect(
      shouldFocusPaneFromEventTarget({
        closest: () => ({ tagName: "A" }) as Element,
      } as unknown as EventTarget),
    ).toBe(false);
    expect(
      shouldFocusPaneFromEventTarget({
        closest: () => ({ tagName: "BUTTON" }) as Element,
      } as unknown as EventTarget),
    ).toBe(false);
  });

  it("returns true for non-interactive pane content", () => {
    expect(
      shouldFocusPaneFromEventTarget({
        closest: () => null,
      } as unknown as EventTarget),
    ).toBe(true);
    expect(shouldFocusPaneFromEventTarget(null)).toBe(true);
  });

  it("returns true for composer text inputs so focusing the composer focuses the pane", () => {
    expect(
      shouldFocusPaneFromEventTarget({
        closest: (selector: string) =>
          selector.includes("input") ? ({ tagName: "INPUT" } as Element) : null,
      } as unknown as EventTarget),
    ).toBe(true);
  });
});
