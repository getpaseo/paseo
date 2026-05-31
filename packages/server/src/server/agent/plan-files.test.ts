import { describe, expect, test } from "vitest";
import { isPlanFilePath, planItemFromToolCall } from "./plan-files.js";

describe("plan file detection", () => {
  test("accepts only narrow Paseo and OpenCode plan markdown paths", () => {
    expect(isPlanFilePath(".paseo/plans/feature.md")).toBe(true);
    expect(isPlanFilePath("/Users/me/project/.paseo/plans/feature.markdown")).toBe(true);
    expect(isPlanFilePath(".opencode/plans/refactor.md")).toBe(true);
    expect(isPlanFilePath("/Users/me/.opencode/plans/refactor.markdown")).toBe(true);

    expect(isPlanFilePath("PLAN.md")).toBe(false);
    expect(isPlanFilePath("docs/plan.md")).toBe(false);
    expect(isPlanFilePath(".paseo/notes/feature.md")).toBe(false);
    expect(isPlanFilePath(".paseo/plans/feature.txt")).toBe(false);
  });

  test("turns successful plan writes into non-actionable plan items", async () => {
    const item = await planItemFromToolCall({
      cwd: "/workspace",
      homeDir: "/Users/me",
      item: {
        type: "tool_call",
        callId: "write-plan",
        name: "write",
        status: "completed",
        error: null,
        detail: {
          type: "write",
          filePath: ".paseo/plans/feature.md",
          content: "# Plan\n\n- Implement it",
        },
      },
    });

    expect(item).toEqual({
      type: "plan",
      planId: "plan-file:.paseo/plans/feature.md",
      text: "# Plan\n\n- Implement it",
    });
  });
});
