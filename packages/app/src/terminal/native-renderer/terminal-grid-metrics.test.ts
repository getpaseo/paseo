import { describe, expect, it } from "vitest";

import { resolveTerminalGridMetricsMeasurement } from "./terminal-grid-metrics";

describe("native terminal grid metrics", () => {
  it("emits measured metrics once until the measurement changes", () => {
    const measured = { cellWidth: 7.2, cellHeight: 16 };

    expect(resolveTerminalGridMetricsMeasurement(null, measured)).toEqual(measured);
    expect(resolveTerminalGridMetricsMeasurement(measured, measured)).toBeNull();
    expect(
      resolveTerminalGridMetricsMeasurement(measured, {
        cellWidth: 7.3,
        cellHeight: 16,
      }),
    ).toEqual({ cellWidth: 7.3, cellHeight: 16 });
  });
});
