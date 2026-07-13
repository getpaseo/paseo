import { describe, expect, it } from "vitest";
import { getPointerActivationConstraint } from "./pointer-activation";

const config = { defaultDistance: 6, handleDistance: 3 };

describe("getPointerActivationConstraint", () => {
  it("uses distance activation for default draggable rows", () => {
    expect(getPointerActivationConstraint(false, config)).toEqual({ distance: 6 });
  });

  it("activates handle-based drags after a short pointer movement", () => {
    expect(getPointerActivationConstraint(true, config)).toEqual({ distance: 3 });
  });
});
