import { describe, expect, it } from "vitest";
import { resolveComposerCapacity } from "./capacity";

describe("composer viewport", () => {
  it("leaves five points below the header for a bottom-anchored composer", () => {
    const height = resolveComposerCapacity({
      height: 582,
      bottomInset: 24,
      keyboardShift: 308,
      centered: false,
    });
    expect(height).toBe(245);
    expect(582 - 24 - 308 - height).toBe(5);
  });

  it("keeps a centered tablet form below the header after translation", () => {
    const height = resolveComposerCapacity({
      height: 1000,
      bottomInset: 80,
      keyboardShift: 300,
      centered: true,
    });
    expect(height).toBe(310);
    expect((1000 - 80 - height) / 2 - 300).toBe(5);
  });

  it("releases space after closing and responds to rotation instead of using window height", () => {
    expect(
      resolveComposerCapacity({ height: 582, bottomInset: 24, keyboardShift: 0, centered: false }),
    ).toBe(553);
    expect(
      resolveComposerCapacity({ height: 300, bottomInset: 0, keyboardShift: 200, centered: false }),
    ).toBe(95);
  });
});
