import { describe, expect, it } from "vitest";
import { formatFileLinkTooltipPath } from "./tooltip-path";

describe("formatFileLinkTooltipPath", () => {
  it("shows a Windows file path relative to its workspace regardless of separators", () => {
    expect(
      formatFileLinkTooltipPath({
        target: {
          path: "C:/Users/me/repo/src/app.ts",
          lineStart: 12,
          lineEnd: 20,
        },
        workspaceRoot: "C:\\Users\\me\\repo",
      }),
    ).toBe("src/app.ts:12-20");
  });
});
