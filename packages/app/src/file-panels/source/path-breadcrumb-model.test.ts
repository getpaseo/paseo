import { describe, expect, it } from "vitest";
import {
  dirnamePath,
  isDirectoryWithin,
  joinAbsolutePath,
  normalizeSlashes,
  resolveFileBreadcrumb,
  toWorkspaceFileOpenPath,
} from "./path-breadcrumb-model";

describe("resolveFileBreadcrumb", () => {
  it("shows a workspace-relative path and maps every segment to its directory", () => {
    expect(
      resolveFileBreadcrumb({
        filePath: "docs/reports/2026/report.md",
        workspaceRoot: "/Users/me/project",
      }),
    ).toEqual({
      displayPath: "docs/reports/2026/report.md",
      absolutePath: "/Users/me/project/docs/reports/2026/report.md",
      directory: "/Users/me/project/docs/reports/2026",
      insideWorkspace: true,
      segments: [
        { label: "docs", directory: "/Users/me/project/docs" },
        { label: "reports", directory: "/Users/me/project/docs/reports" },
        { label: "2026", directory: "/Users/me/project/docs/reports/2026" },
        { label: "report.md", directory: "/Users/me/project/docs/reports/2026" },
      ],
    });
  });

  it("keeps an absolute file inside the workspace relative too", () => {
    const breadcrumb = resolveFileBreadcrumb({
      filePath: "/Users/me/project/src/app.ts",
      workspaceRoot: "/Users/me/project/",
    });
    expect(breadcrumb?.displayPath).toBe("src/app.ts");
    expect(breadcrumb?.segments[0]?.directory).toBe("/Users/me/project/src");
  });

  it("falls back to the absolute path outside the workspace", () => {
    const breadcrumb = resolveFileBreadcrumb({
      filePath: "/tmp/shared/notes.md",
      workspaceRoot: "/Users/me/project",
    });
    expect(breadcrumb?.insideWorkspace).toBe(false);
    expect(breadcrumb?.displayPath).toBe("/tmp/shared/notes.md");
    expect(breadcrumb?.segments.map((segment) => segment.label)).toEqual([
      "tmp",
      "shared",
      "notes.md",
    ]);
    expect(breadcrumb?.segments[1]?.directory).toBe("/tmp/shared");
  });

  it("handles Windows drive paths case-insensitively", () => {
    const breadcrumb = resolveFileBreadcrumb({
      filePath: "C:\\Repo\\src\\app.ts",
      workspaceRoot: "c:/repo",
    });
    expect(breadcrumb?.displayPath).toBe("src/app.ts");
    expect(breadcrumb?.segments[0]?.directory).toBe("C:/Repo/src");
  });

  it("rejects the workspace root and empty paths", () => {
    expect(
      resolveFileBreadcrumb({ filePath: "/Users/me/project", workspaceRoot: "/Users/me/project" }),
    ).toBeNull();
    expect(resolveFileBreadcrumb({ filePath: " ", workspaceRoot: "/repo" })).toBeNull();
    expect(resolveFileBreadcrumb({ filePath: "a.ts", workspaceRoot: "relative" })).toBeNull();
  });
});

describe("path helpers", () => {
  it("normalizes separators and trailing slashes", () => {
    expect(normalizeSlashes("C:\\repo\\\\src\\")).toBe("C:/repo/src");
    expect(normalizeSlashes("/repo///src/")).toBe("/repo/src");
    expect(normalizeSlashes("//server/share/src/")).toBe("//server/share/src");
  });

  it("joins absolute paths at the filesystem root", () => {
    expect(joinAbsolutePath("/", "a.ts")).toBe("/a.ts");
    expect(joinAbsolutePath("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
    expect(dirnamePath("/repo/src/a.ts")).toBe("/repo/src");
    expect(dirnamePath("/a")).toBe("/");
    expect(dirnamePath("C:/a")).toBe("C:/");
  });

  it("opens inside files relative to the workspace and outside files absolute", () => {
    expect(toWorkspaceFileOpenPath("/repo/docs/a.md", "/repo")).toBe("docs/a.md");
    expect(toWorkspaceFileOpenPath("/tmp/a.md", "/repo")).toBe("/tmp/a.md");
  });

  it("checks directory containment", () => {
    expect(isDirectoryWithin("/repo/src", "/repo")).toBe(true);
    expect(isDirectoryWithin("/repo2", "/repo")).toBe(false);
  });
});
