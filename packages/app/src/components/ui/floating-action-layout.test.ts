import { describe, expect, it } from "vitest";
import {
  floatingActionsClearance,
  FLOATING_ACTION_BUTTON_CLEARANCE,
} from "./floating-action-layout";

describe("floating action scroll clearance", () => {
  it("keeps the last diff line above Jump to file before and after feedback is added", () => {
    const jump = FLOATING_ACTION_BUTTON_CLEARANCE;
    const feedback = FLOATING_ACTION_BUTTON_CLEARANCE + 44;
    expect(floatingActionsClearance([jump, 0], 34)).toBe(106);
    expect(floatingActionsClearance([jump, feedback], 34)).toBe(222);
    expect(floatingActionsClearance([0, feedback], 34)).toBe(150);
    expect(floatingActionsClearance([jump, feedback], 0)).toBe(188);
    expect(floatingActionsClearance([0, 0], 34)).toBe(0);
  });
});
