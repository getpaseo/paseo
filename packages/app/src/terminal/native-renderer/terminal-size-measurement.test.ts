import { describe, expect, test } from "vitest";

import { resolveMeasuredNativeTerminalSize } from "./terminal-size-measurement";

describe("terminal size measurement", () => {
  test("measured layout height owns terminal rows", () => {
    expect(
      resolveMeasuredNativeTerminalSize({
        layout: { width: 530, height: 580 },
        metrics: { cellWidth: 10, cellHeight: 20 },
      }),
    ).toEqual({ rows: 29, cols: 53 });
  });
});
