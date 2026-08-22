import { describe, expect, it } from "vitest";
import { resolveComposerInputHeightStyle, shouldScrollComposerInput } from "./height-style";

describe("composer input height style", () => {
  it("applies the measured height alongside its bounds", () => {
    expect(
      resolveComposerInputHeightStyle({
        inputHeight: 96,
        minInputHeight: 30,
        maxInputHeight: 240,
        applyMeasuredHeight: true,
      }),
    ).toEqual({
      height: 96,
      minHeight: 30,
      maxHeight: 240,
    });
  });

  it("lets a native multiline input expose its intrinsic content height", () => {
    expect(
      resolveComposerInputHeightStyle({
        inputHeight: 96,
        minInputHeight: 30,
        maxInputHeight: 240,
        applyMeasuredHeight: false,
      }),
    ).toEqual({
      minHeight: 30,
      maxHeight: 240,
    });
  });

  it("keeps native measurement unconstrained until the composer reaches its cap", () => {
    expect(shouldScrollComposerInput({ inputHeight: 30, maxInputHeight: 240 })).toBe(false);
    expect(shouldScrollComposerInput({ inputHeight: 240, maxInputHeight: 240 })).toBe(true);
  });
});
