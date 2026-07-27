import { describe, expect, it } from "vitest";
import { shouldRevealMutedDisclosure } from "./expandable-badge-state";

describe("shouldRevealMutedDisclosure", () => {
  it("hides the disclosure while idle", () => {
    expect(
      shouldRevealMutedDisclosure({
        isInteractive: true,
        isHovered: false,
        isPressed: false,
      }),
    ).toBe(false);
  });

  it.each([
    ["hover", { isHovered: true }],
    ["press", { isPressed: true }],
  ])("reveals the disclosure on %s", (_label, activeState) => {
    expect(
      shouldRevealMutedDisclosure({
        isInteractive: true,
        isHovered: false,
        isPressed: false,
        ...activeState,
      }),
    ).toBe(true);
  });

  it("does not reveal for non-interactive rows", () => {
    expect(
      shouldRevealMutedDisclosure({
        isInteractive: false,
        isHovered: true,
        isPressed: true,
      }),
    ).toBe(false);
  });
});
