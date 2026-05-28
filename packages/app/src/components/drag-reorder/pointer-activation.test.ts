import { describe, expect, it } from "vitest";
import { getPointerActivationConstraint } from "./pointer-activation";

const config = { defaultDistance: 6, holdDelayMs: 250, holdTolerance: 8 };

describe("getPointerActivationConstraint", () => {
  it("uses distance activation for default draggable rows", () => {
    expect(getPointerActivationConstraint(false, config)).toEqual({ distance: 6 });
  });

  it("requires a held pointer before activating handle-based drags", () => {
    expect(getPointerActivationConstraint(true, config)).toEqual({ delay: 250, tolerance: 8 });
  });
});
