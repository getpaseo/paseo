import { describe, expect, it } from "vitest";
import {
  buildProjectPickerOptions,
  formatDirectoryCompletion,
  isOpenableProjectPath,
} from "./project-picker-options";

describe("isOpenableProjectPath", () => {
  it("accepts POSIX, tilde, full-width tilde, Windows drive-letter, and UNC paths", () => {
    expect(isOpenableProjectPath("/repo")).toBe(true);
    expect(isOpenableProjectPath("~")).toBe(true);
    expect(isOpenableProjectPath("~/")).toBe(true);
    expect(isOpenableProjectPath("~/src")).toBe(true);
    expect(isOpenableProjectPath("~\\src")).toBe(true);
    expect(isOpenableProjectPath("～")).toBe(true);
    expect(isOpenableProjectPath("～/src")).toBe(true);
    expect(isOpenableProjectPath("C:\\Users\\mo")).toBe(true);
    expect(isOpenableProjectPath("c:/users/mo")).toBe(true);
    expect(isOpenableProjectPath("\\\\server\\share")).toBe(true);
  });

  it("rejects relative and non-separator tilde input", () => {
    expect(isOpenableProjectPath("repo")).toBe(false);
    expect(isOpenableProjectPath("repo/sub")).toBe(false);
    expect(isOpenableProjectPath("c:repo")).toBe(false);
    expect(isOpenableProjectPath("~repo")).toBe(false);
    expect(isOpenableProjectPath("～repo")).toBe(false);
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
      serverPaths: ["/repo/api"],
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
      serverPaths: ["/Users/mo/src/api"],
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

  it("does not duplicate an existing suggestion when typed with a tilde or trailing slash", () => {
    expect(
      buildProjectPickerOptions({
        recommendedPaths: [],
        serverPaths: ["/Users/mo/src", "/Users/mo/src/api"],
        query: "~/src",
      }),
    ).toEqual([
      { kind: "suggestion", path: "/Users/mo/src" },
      { kind: "suggestion", path: "/Users/mo/src/api" },
    ]);

    expect(
      buildProjectPickerOptions({
        recommendedPaths: [],
        serverPaths: ["/Users/mo/src", "/Users/mo/src/api"],
        query: "～/src/",
      }),
    ).toEqual([
      { kind: "suggestion", path: "/Users/mo/src" },
      { kind: "suggestion", path: "/Users/mo/src/api" },
    ]);
  });

  it("normalizes a full-width tilde when creating an open-path row", () => {
    const options = buildProjectPickerOptions({
      recommendedPaths: [],
      serverPaths: [],
      query: "～/src",
    });

    expect(options).toEqual([{ kind: "path", path: "~/src" }]);
  });
});

describe("formatDirectoryCompletion", () => {
  it("shortens home paths to tilde form with a trailing slash for word and tilde queries", () => {
    expect(formatDirectoryCompletion("/Users/mo/Code", "~/Co")).toBe("~/Code/");
    expect(formatDirectoryCompletion("/Users/mo/Code", "Code")).toBe("~/Code/");
    expect(formatDirectoryCompletion("/Users/mo/Code", "～/Co")).toBe("~/Code/");
    expect(formatDirectoryCompletion("~/Code", "~/Co")).toBe("~/Code/");
    expect(formatDirectoryCompletion("~/Code/", "~/Code/")).toBe("~/Code/");
    expect(formatDirectoryCompletion("~", "~")).toBe("~/");
  });

  it("preserves explicit POSIX absolute paths and Windows separators", () => {
    expect(formatDirectoryCompletion("/Users/mo/Code", "/Users/mo/Co")).toBe("/Users/mo/Code/");
    expect(formatDirectoryCompletion("/", "/")).toBe("/");
    expect(formatDirectoryCompletion("C:\\Users\\mo\\Code", "C:\\Users\\mo")).toBe(
      "C:\\Users\\mo\\Code\\",
    );
  });
});
