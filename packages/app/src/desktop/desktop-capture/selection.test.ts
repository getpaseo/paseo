import { expect, it } from "vitest";
import { captureSelection } from "./selection";
it("normalizes backwards drags and clamps them to the screenshot", () => {
  expect(
    captureSelection({ x: 130, y: 80 }, { x: -20, y: 10 }, { width: 100, height: 100 }),
  ).toEqual({ x: 0, y: 10, width: 100, height: 70 });
});
it("ignores clicks without an area", () => {
  expect(
    captureSelection({ x: 10, y: 10 }, { x: 10, y: 10 }, { width: 100, height: 100 }),
  ).toBeNull();
});
