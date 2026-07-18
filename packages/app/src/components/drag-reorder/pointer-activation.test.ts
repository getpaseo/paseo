import { describe, expect, it } from "vitest";
import { getDragActivationConstraints } from "./pointer-activation";

const config = { movementDistance: 6, touchHoldDelayMs: 180, touchHoldTolerance: 8 };

describe("getDragActivationConstraints", () => {
  it("starts mouse drags after deliberate pointer movement", () => {
    expect(getDragActivationConstraints(true, config).mouse).toEqual({ distance: 6 });
  });

  it("requires a short hold before starting touch drags", () => {
    expect(getDragActivationConstraints(true, config).touch).toEqual({
      delay: 180,
      tolerance: 8,
    });
  });

  it("starts ordinary touch rows after deliberate movement", () => {
    expect(getDragActivationConstraints(false, config).touch).toEqual({ distance: 6 });
  });
});
