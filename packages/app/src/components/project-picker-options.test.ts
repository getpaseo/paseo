import { describe, expect, it } from "vitest";
import {
  buildProjectPickerBrowseOptions,
  buildProjectPickerOptions,
  getProjectPickerBrowseParentPath,
  isOpenableProjectPath,
  joinProjectPickerBrowsePath,
} from "./project-picker-options";

describe("isOpenableProjectPath", () => {
  it("accepts POSIX, tilde, Windows drive-letter, and UNC paths", () => {
    expect(isOpenableProjectPath("/repo")).toBe(true);
    expect(isOpenableProjectPath("~/src")).toBe(true);
    expect(isOpenableProjectPath("C:\\Users\\mo")).toBe(true);
    expect(isOpenableProjectPath("c:/users/mo")).toBe(true);
    expect(isOpenableProjectPath("\\\\server\\share")).toBe(true);
  });

  it("rejects relative input", () => {
    expect(isOpenableProjectPath("repo")).toBe(false);
    expect(isOpenableProjectPath("repo/sub")).toBe(false);
    expect(isOpenableProjectPath("c:repo")).toBe(false);
    expect(isOpenableProjectPath("")).toBe(false);
  });
});

describe("buildProjectPickerOptions", () => {
  it("does not create an open-path row for word queries", () => {
    const options = buildProjectPickerOptions({
      recommendedPaths: ["/repo/api"],
      serverPaths: ["/repo/app"],
      query: "repo",
    });

    expect(options).toEqual([
      { kind: "suggestion", path: "/repo/api" },
      { kind: "suggestion", path: "/repo/app" },
    ]);
  });

  it("puts an absolute path row first", () => {
    const options = buildProjectPickerOptions({
      recommendedPaths: ["/repo/api"],
      serverPaths: [],
      query: "/repo",
    });

    expect(options).toEqual([
      { kind: "path", path: "/repo" },
      { kind: "suggestion", path: "/repo/api" },
    ]);
  });

  it("puts a home-relative path row first", () => {
    const options = buildProjectPickerOptions({
      recommendedPaths: ["/Users/mo/src/api"],
      serverPaths: [],
      query: "~/src",
    });

    expect(options).toEqual([
      { kind: "path", path: "~/src" },
      { kind: "suggestion", path: "/Users/mo/src/api" },
    ]);
  });

  it("creates an open-path row for Windows paths", () => {
    const options = buildProjectPickerOptions({
      recommendedPaths: [],
      serverPaths: [],
      query: "C:\\Users\\mo\\src",
    });

    expect(options).toEqual([{ kind: "path", path: "C:\\Users\\mo\\src" }]);
  });

  it("does not duplicate an existing suggestion", () => {
    const options = buildProjectPickerOptions({
      recommendedPaths: ["/repo/api"],
      serverPaths: ["/repo/app"],
      query: "/repo/app",
    });

    expect(options).toEqual([{ kind: "suggestion", path: "/repo/app" }]);
  });
});

describe("project picker browse options", () => {
  it("starts home browsing with the current directory and child directories", () => {
    const options = buildProjectPickerBrowseOptions({
      cwd: "~",
      childPaths: ["src", "Downloads"],
    });

    expect(options).toEqual([
      { kind: "browse-current", path: "~" },
      { kind: "browse-directory", path: "~/src" },
      { kind: "browse-directory", path: "~/Downloads" },
    ]);
  });

  it("adds a parent row outside the home root", () => {
    const options = buildProjectPickerBrowseOptions({
      cwd: "~/src/paseo",
      childPaths: ["packages"],
    });

    expect(options).toEqual([
      { kind: "browse-current", path: "~/src/paseo" },
      { kind: "browse-parent", path: "~/src" },
      { kind: "browse-directory", path: "~/src/paseo/packages" },
    ]);
  });

  it("dedupes child paths that point at existing browse actions", () => {
    const options = buildProjectPickerBrowseOptions({
      cwd: "/workspace",
      childPaths: [".", "/workspace/src", "workspace/src", "src"],
    });

    expect(options).toEqual([
      { kind: "browse-current", path: "/workspace" },
      { kind: "browse-parent", path: "/" },
      { kind: "browse-directory", path: "/workspace/src" },
    ]);
  });

  it("resolves parent paths for tilde, POSIX, and Windows-style directories", () => {
    expect(getProjectPickerBrowseParentPath("~")).toBeNull();
    expect(getProjectPickerBrowseParentPath("~/src/paseo")).toBe("~/src");
    expect(getProjectPickerBrowseParentPath("/Users/mo/src")).toBe("/Users/mo");
    expect(getProjectPickerBrowseParentPath("/")).toBeNull();
    expect(getProjectPickerBrowseParentPath("C:\\Users\\mo")).toBe("C:\\Users");
    expect(getProjectPickerBrowseParentPath("C:\\Users\\mo\\")).toBe("C:\\Users");
  });

  it("joins relative server child paths under the current browsed directory", () => {
    expect(joinProjectPickerBrowsePath("~/src", "paseo")).toBe("~/src/paseo");
    expect(joinProjectPickerBrowsePath("/workspace", "./packages/app")).toBe(
      "/workspace/packages/app",
    );
    expect(joinProjectPickerBrowsePath("~/src", "/tmp/project")).toBe("/tmp/project");
  });
});
