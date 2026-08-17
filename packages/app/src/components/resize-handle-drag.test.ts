import { describe, expect, it, vi } from "vitest";
import { startResizeHandleDrag } from "@/components/resize-handle-drag";

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
