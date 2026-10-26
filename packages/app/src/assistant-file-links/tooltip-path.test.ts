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
    expect(
      formatFileLinkTooltipPath({
        target: { path: "C:/src/app.ts", lineStart: 12 },
        workspaceRoot: "C:\\",
      }),
    ).toBe("src/app.ts:12");
  });

  it("shows the workspace root as a dot", () => {
    expect(
      formatFileLinkTooltipPath({
        target: { path: "/Users/me/repo" },
        workspaceRoot: "/Users/me/repo",
      }),
    ).toBe(".");
    expect(
      formatFileLinkTooltipPath({
        target: { path: "C:/Users/Me/Repo/", lineStart: 4 },
        workspaceRoot: "c:\\users\\me\\repo",
      }),
    ).toBe(".:4");
  });

  it("keeps an absolute path outside the workspace", () => {
    expect(
      formatFileLinkTooltipPath({
        target: { path: "/Users/me/notes.md" },
        workspaceRoot: "/Users/me/repo",
      }),
    ).toBe("/Users/me/notes.md");
    expect(
      formatFileLinkTooltipPath({
        target: { path: "C:/Users/me/notes.md", lineStart: 8 },
        workspaceRoot: "C:\\Users\\me\\repo",
      }),
    ).toBe("C:/Users/me/notes.md:8");
  });

  it("keeps the target path when the workspace root is unavailable", () => {
    expect(formatFileLinkTooltipPath({ target: { path: "src/app.ts", lineStart: 12 } })).toBe(
      "src/app.ts:12",
    );
  });
});
