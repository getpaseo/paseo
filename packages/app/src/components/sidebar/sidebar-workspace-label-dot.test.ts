import { describe, expect, it } from "vitest";
import { workspaceLabelColorIndex } from "./sidebar-workspace-label-dot";

describe("workspaceLabelColorIndex", () => {
  it("assigns a stable palette index to a workspace label", () => {
    expect(workspaceLabelColorIndex("label-review")).toBe(workspaceLabelColorIndex("label-review"));
    expect(workspaceLabelColorIndex("label-review")).toBeGreaterThanOrEqual(0);
    expect(workspaceLabelColorIndex("label-review")).toBeLessThan(6);
  });
});
