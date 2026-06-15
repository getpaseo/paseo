import { describe, expect, it } from "vitest";
import { buildProjectPickerOptions, isOpenableProjectPath } from "./project-picker-options";

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
