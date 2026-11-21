import { describe, expect, it } from "vitest";
import { resolveDraggedShare } from "./resize-handle-share";

describe("resolveDraggedShare", () => {
  it("saves the pointer share while it is above the content", () => {
    expect(resolveDraggedShare(0.2, 0.5, 0.4)).toBe(0.2);
  });

  it("keeps a larger existing share when the drag ends at or below the content", () => {
    expect(resolveDraggedShare(0.45, 0.5, 0.4)).toBe(0.5);
    expect(resolveDraggedShare(0.4, 0.5, 0.4)).toBe(0.5);
  });

  it("uses the content share when it is larger than the existing share", () => {
    expect(resolveDraggedShare(0.45, 0.3, 0.4)).toBe(0.4);
  });
});
