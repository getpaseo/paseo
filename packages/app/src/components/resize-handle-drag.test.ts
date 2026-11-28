import { describe, expect, it, vi } from "vitest";
import {
  resolveResizeHandleInteraction,
  startResizeHandleDrag,
} from "@/components/resize-handle-drag";

describe("startResizeHandleDrag", () => {
  it("previews pointer frames and commits only the final size", () => {
    const preview = vi.fn();
    const commit = vi.fn();
    const drag = startResizeHandleDrag({
      sizes: [0.5, 0.5],
      index: 0,
      preview,
      commit,
    });

    drag.move(0.05);
    drag.move(0.1);

    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview.mock.calls[0]?.[0][0]).toBeCloseTo(0.55, 10);
    expect(preview.mock.calls[0]?.[0][1]).toBeCloseTo(0.45, 10);
    expect(preview.mock.calls[1]?.[0][0]).toBeCloseTo(0.6, 10);
    expect(preview.mock.calls[1]?.[0][1]).toBeCloseTo(0.4, 10);
    expect(commit).not.toHaveBeenCalled();

    drag.finish();

    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]?.[0][0]).toBeCloseTo(0.6, 10);
    expect(commit.mock.calls[0]?.[0][1]).toBeCloseTo(0.4, 10);
  });
});

describe("resolveResizeHandleInteraction", () => {
  it("uses DOM pointer events only on fine-pointer web targets, gesture pan on GPUI, and touch grip on touch targets", () => {
    expect(resolveResizeHandleInteraction({ finePointer: true, isWeb: true })).toBe("web-pointer");
    expect(resolveResizeHandleInteraction({ finePointer: true, isWeb: false })).toBe(
      "native-pointer",
    );
    expect(resolveResizeHandleInteraction({ finePointer: false, isWeb: false })).toBe("touch");
    expect(resolveResizeHandleInteraction({ finePointer: false, isWeb: true })).toBe("touch");
  });
});
